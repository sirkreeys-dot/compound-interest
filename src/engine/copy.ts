import { randomUUID } from "node:crypto";
import type { AppConfig, NormalizedAlert, OpenPosition } from "../types.js";
import type { EnvConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { ExecutionRouter } from "../execution/index.js";
import type { KillSwitch } from "../utils/killswitch.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import type { Watchlist } from "./watchlist.js";
import type { FomoRestClient } from "../fomo/client.js";
import { evaluateAlert } from "./filters.js";
import { findTraderTokenAmount, resolveSellFraction } from "./sellFraction.js";
import { log } from "../utils/logger.js";
import { Mutex } from "../utils/mutex.js";
import { scaleRawAmount } from "../utils/money.js";
import { redactSecrets } from "../security/redact.js";

export class CopyEngine {
  private readonly mutex = new Mutex();

  constructor(
    private readonly env: EnvConfig,
    private readonly cfg: AppConfig,
    private readonly store: Store,
    private readonly exec: ExecutionRouter,
    private readonly kill: KillSwitch,
    private readonly tg: TelegramNotifier,
    private readonly watchlist: Watchlist,
    private readonly fomo: FomoRestClient | null = null,
  ) {}

  async handleAlert(alert: NormalizedAlert): Promise<void> {
    await this.mutex.runExclusive(() => this.handleAlertExclusive(alert));
  }

  private async handleAlertExclusive(alert: NormalizedAlert): Promise<void> {
    const filtered = evaluateAlert(alert, {
      cfg: this.cfg,
      store: this.store,
      dryRun: this.env.dryRun,
      paused: this.kill.isPaused(),
      watchlist: this.watchlist,
    });

    if (!filtered.ok) {
      log.info(
        `SKIP ${alert.alertType} ${alert.tokenSymbol ?? "?"} @ ${alert.traderHandle}: ${filtered.reason} ${filtered.detail ?? ""}`,
      );
      if (filtered.reason !== "already_processed") {
        await this.tg.notifySkip(alert, filtered.reason ?? "other", filtered.detail);
      }
      if (
        filtered.reason === "trader_not_watched" ||
        filtered.reason === "unsupported_chain" ||
        filtered.reason === "trader_inactive_alumni"
      ) {
        this.store.claimEventStrict(alert.eventId);
      }
      return;
    }

    if (!this.store.claimEventStrict(alert.eventId)) {
      log.info(`SKIP already_processed (lost claim race) ${alert.eventId}`);
      return;
    }

    if (alert.alertType === "buy") {
      await this.copyBuy(alert, filtered.sizeUsd!);
    } else if (alert.alertType === "sell") {
      const key =
        filtered.watched?.userId ??
        filtered.watched?.handle ??
        alert.userId ??
        alert.traderHandle ??
        "";
      await this.copySell(alert, key);
    }
  }

  private async copyBuy(alert: NormalizedAlert, sizeUsd: number): Promise<void> {
    const dryRun = this.env.dryRun;
    log.info(
      `${dryRun ? "[DRY_RUN] " : ""}BUY $${sizeUsd} of ${alert.tokenSymbol} (${alert.tokenAddress}) on ${alert.chain} copying ${alert.traderHandle}`,
    );

    let pendingId: string | undefined;
    if (!dryRun && alert.chain === "solana") {
      pendingId = randomUUID();
      this.store.insertPendingSwap({
        id: pendingId,
        chain: alert.chain,
        side: "buy",
        sourceEventId: alert.eventId,
        traderUserId: alert.userId,
        traderHandle: alert.traderHandle,
        tokenAddress: alert.tokenAddress,
        tokenSymbol: alert.tokenSymbol,
        sizeUsd,
        buyToken: alert.tokenAddress,
        notes: "pre_broadcast",
      });
    }

    const result = await this.exec.buy(alert.chain, {
      sellToken: "",
      buyToken: alert.tokenAddress!,
      sellUsd: sizeUsd,
      slippageBps: this.cfg.risk.maxSlippageBps,
      dryRun,
      pendingId,
      sourceEventId: alert.eventId,
      traderUserId: alert.userId,
      traderHandle: alert.traderHandle,
      tokenSymbol: alert.tokenSymbol,
    });
    pendingId = result.pendingId ?? pendingId;

    if (!result.ok) {
      log.error(`Buy failed: ${result.error}`);
      await this.tg.notifySkip(alert, "execution_failed", result.error ? redactSecrets(result.error) : result.error);
      return;
    }
    if (!dryRun && result.dryRun) {
      log.error("Buy returned dryRun result while LIVE — refusing to open position");
      if (pendingId) {
        this.store.updatePendingSwap(pendingId, {
          status: "unresolved",
          error: "live requested but executor dry-ran",
        });
      }
      await this.tg.notifySkip(alert, "execution_failed", "live requested but executor dry-ran");
      return;
    }
    if (!result.outAmountRaw) {
      log.error("Buy succeeded but no outAmountRaw — refusing phantom position");
      if (pendingId) {
        this.store.updatePendingSwap(pendingId, {
          status: "unresolved",
          error: "missing outAmountRaw after confirmed swap",
          txSignature: result.txHash ?? null,
        });
        await this.tg.send(
          `<b>⚠️ Untracked fill</b>
Buy confirmed but outAmountRaw missing. pending=${pendingId} tx=${result.txHash ?? "?"}`,
        );
      }
      await this.tg.notifySkip(alert, "execution_failed", "missing outAmountRaw");
      return;
    }

    let traderTokenAmountAtEntry: number | null = null;
    const traderKey = alert.userId ?? alert.traderHandle;
    if (this.fomo && traderKey && alert.tokenAddress) {
      try {
        const body = await this.fomo.positions(traderKey);
        traderTokenAmountAtEntry = findTraderTokenAmount(body, alert.tokenAddress);
      } catch (e) {
        log.debug("Could not snapshot trader token amount at entry", e);
      }
    }

    const pos: OpenPosition = {
      id: randomUUID(),
      traderUserId: alert.userId,
      traderHandle: alert.traderHandle,
      tradeId: alert.tradeId,
      chain: alert.chain,
      tokenAddress: alert.tokenAddress!,
      tokenSymbol: alert.tokenSymbol,
      entryUsd: sizeUsd,
      sizeUsd,
      remainingUsd: sizeUsd,
      quantityRaw: result.outAmountRaw,
      entryPriceUsd: null,
      traderSizeAtEntryUsd: alert.tradeUsd ?? alert.positionValueUsd ?? null,
      traderTokenAmountAtEntry,
      openedAt: new Date().toISOString(),
      sourceEventId: alert.eventId,
      status: dryRun ? "dry_open" : "open",
      isDryRun: dryRun,
      txEntry: result.txHash ?? null,
    };

    try {
      this.store.insertPosition(pos);
    } catch (e) {
      log.error("insertPosition failed", e);
      if (pendingId) {
        this.store.updatePendingSwap(pendingId, {
          status: "unresolved",
          error: "insertPosition failed after live swap",
          txSignature: result.txHash ?? null,
          notes: "tokens may be in wallet — reconcile on restart",
        });
        await this.tg.send(
          `<b>⚠️ Untracked fill</b>
Live buy succeeded but DB insert failed.\npending=<code>${pendingId}</code>\ntx=<code>${result.txHash ?? "?"}</code>\ntoken=<code>${alert.tokenAddress}</code>`,
        );
      }
      await this.tg.notifySkip(alert, "execution_failed", "db insert failed");
      return;
    }

    if (pendingId) this.store.markPendingReconciled(pendingId, pos.id);
    if (!dryRun) this.store.addSpend(sizeUsd);
    this.store.setLastEntryAt(Date.now());

    await this.tg.notifyEntry({
      alert,
      sizeUsd,
      dryRun: result.dryRun,
      txHash: result.txHash,
      quoteSummary: result.quoteSummary,
    });
  }

  private async copySell(alert: NormalizedAlert, traderKey: string): Promise<void> {
    const includeDry = this.env.dryRun;
    let pos = this.store.findOpenByTraderToken(
      traderKey,
      alert.tokenAddress!,
      alert.chain,
      { includeDryRun: includeDry },
    );
    if (!pos && alert.traderHandle) {
      pos = this.store.findOpenByTraderToken(
        alert.traderHandle,
        alert.tokenAddress!,
        alert.chain,
        { includeDryRun: includeDry },
      );
    }
    if (!pos && alert.userId) {
      pos = this.store.findOpenByTraderToken(alert.userId, alert.tokenAddress!, alert.chain, {
        includeDryRun: includeDry,
      });
    }
    if (!pos) {
      await this.tg.notifySkip(alert, "sell_without_our_position");
      return;
    }
    await this.closePosition(pos, "trader_sell", alert);
  }

  async closePosition(
    pos: OpenPosition,
    reason: string,
    alert?: NormalizedAlert,
  ): Promise<void> {
    const dryRun = this.env.dryRun || pos.isDryRun;
    const locked = this.store.claimPositionForClose(pos.id);
    if (!locked) {
      log.info(`Position ${pos.id} already closing/closed — skip`);
      return;
    }

    let fraction = 1;
    let fractionMethod = "full";
    let fractionDetail = "tp_sl_or_forced";
    if (reason === "trader_sell") {
      const resolved = await resolveSellFraction({
        pos: locked,
        alert,
        fomo: this.fomo,
      });
      fraction = resolved.fraction;
      fractionMethod = resolved.method;
      fractionDetail = resolved.detail;
      log.info(`Sell fraction method=${fractionMethod} fraction=${fraction} (${fractionDetail})`);
      await this.tg.notifySellSizing({
        method: fractionMethod,
        fraction,
        detail: fractionDetail,
      });
    }

    if (!locked.quantityRaw) {
      log.error(`Sell aborted: position ${pos.id} has no quantityRaw`);
      this.store.revertClosingToOpen(pos.id);
      if (alert) await this.tg.notifySkip(alert, "execution_failed", "no quantityRaw");
      return;
    }

    const sellRaw = scaleRawAmount(locked.quantityRaw, fraction);
    if (sellRaw === "0") {
      this.store.revertClosingToOpen(pos.id);
      return;
    }

    log.info(
      `${dryRun ? "[DRY_RUN] " : ""}SELL ${locked.tokenSymbol} on ${locked.chain} reason=${reason} fraction=${fraction.toFixed(4)} raw=${sellRaw}`,
    );

    const result = await this.exec.sell(locked.chain, {
      sellToken: locked.tokenAddress,
      buyToken: "",
      sellUsd: locked.remainingUsd * fraction,
      sellAmountRaw: sellRaw,
      slippageBps: this.cfg.risk.maxSlippageBps,
      dryRun,
    });

    if (!result.ok) {
      log.error(`Sell failed: ${result.error}`);
      this.store.revertClosingToOpen(pos.id);
      if (alert) await this.tg.notifySkip(alert, "execution_failed", result.error ? redactSecrets(result.error) : result.error);
      return;
    }
    if (!dryRun && result.dryRun) {
      log.error("Sell returned dryRun while LIVE — reverting lock");
      this.store.revertClosingToOpen(pos.id);
      if (alert) await this.tg.notifySkip(alert, "execution_failed", "live sell dry-ran");
      return;
    }

    const exitUsd = result.outUsd ?? locked.remainingUsd * fraction;
    const costBasis = locked.remainingUsd * fraction;
    const pnl = exitUsd - costBasis;
    const fullyClosed = fraction >= 0.999 || sellRaw === locked.quantityRaw;
    const remainingRaw = fullyClosed
      ? "0"
      : (BigInt(locked.quantityRaw) - BigInt(sellRaw)).toString();
    const remainingUsd = fullyClosed
      ? 0
      : Math.max(0, locked.remainingUsd * (1 - fraction));

    this.store.applyPartialClose(locked.id, {
      soldRaw: sellRaw,
      remainingRaw,
      remainingUsd,
      realizedPnlUsd: pnl,
      txExit: result.txHash,
      fullyClosed,
      isDryRun: dryRun,
      exitReason: `${reason}:${fractionMethod}`,
      exitUsd,
    });

    if (!dryRun) this.store.addRealizedPnl(pnl);

    await this.tg.notifyExit({
      pos: locked,
      reason: fullyClosed
        ? `${reason} (${fractionMethod})`
        : `${reason}_partial_${(fraction * 100).toFixed(1)}pct (${fractionMethod})`,
      exitUsd,
      pnlUsd: pnl,
      dryRun,
      txHash: result.txHash,
    });
    await this.tg.notifyPnl(
      `${fullyClosed ? "Closed" : "Partial"} ${locked.tokenSymbol ?? locked.tokenAddress} (${reason}/${fractionMethod}): ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}. Today realized: $${this.store.getDaily().realizedPnlUsd.toFixed(2)}`,
    );
  }
}
