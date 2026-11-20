import { randomUUID } from "node:crypto";
import type { AppConfig, NormalizedAlert, OpenPosition, SkipReason } from "../types.js";
import type { EnvConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { ExecutionRouter } from "../execution/index.js";
import type { SwapResult } from "../execution/types.js";
import type { KillSwitch } from "../utils/killswitch.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import type { Watchlist } from "./watchlist.js";
import type { FomoRestClient } from "../fomo/client.js";
import { evaluateAlert } from "./filters.js";
import { findTraderTokenAmount, mapTraderSellToOurFraction, resolveSellFraction } from "./sellFraction.js";
import { batchSellKey, buysSuppressedBySameBatch, tokenLockKey } from "./batch.js";
import { log } from "../utils/logger.js";
import { KeyedMutex, Mutex } from "../utils/mutex.js";
import { scaleRawAmount } from "../utils/money.js";
import { redactSecrets } from "../security/redact.js";

const CLAIM_ON_SKIP = new Set<SkipReason>([
  "trader_not_watched",
  "unsupported_chain",
  "trader_inactive_alumni",
  "invalid_token_address",
  "no_token_address",
  "token_safety",
  "same_batch_sell",
  "below_min_trader_size",
  "market_cap",
  "first_buys_only",
  "chain_disabled_for_trader",
]);

const MIRRORED_SELL = new Set(["trader_sell", "reconcile_flat"]);

interface EntryHold {
  traderKey: string;
  spend: number;
  slot: boolean;
  cooldownTs: number;
}

/**
 * Copy engine.
 * Alerts for different tokens run concurrently. Alerts for the same token share
 * a lock so dedupe, merges, and sells stay ordered. Budget, slot count, and the
 * per-trader cooldown are reserved under a separate short lock so two tokens
 * cannot both pass a check that only one of them should win.
 * Telegram sends are not awaited on that path.
 */
export class CopyEngine {
  private readonly tokens = new KeyedMutex();
  private readonly budget = new Mutex();
  /** Token keys whose lock this call stack already holds (the mutex is not reentrant). */
  private readonly heldTokens = new Set<string>();
  private reservedSpend = 0;
  private reservedSlots = 0;
  private readonly cooldownHold = new Map<string, number>();

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

  async handleAlert(alert: NormalizedAlert, opts?: { suppressBuy?: boolean }): Promise<void> {
    const key = tokenLockKey(alert.chain, alert.tokenAddress ?? alert.eventId);
    await this.withToken(key, () => this.handleExclusive(alert, opts));
  }

  /** REST (and any other batched feed) entry point. */
  async handleAlerts(alerts: NormalizedAlert[]): Promise<void> {
    const suppressed = buysSuppressedBySameBatch(alerts);
    await Promise.all(
      alerts.map((alert) =>
        this.handleAlert(alert, {
          suppressBuy: alert.alertType === "buy" && suppressed.has(alert.eventId),
        }),
      ),
    );
  }

  async closePosition(
    pos: OpenPosition,
    reason: string,
    alert?: NormalizedAlert,
    opts?: { fraction?: number },
  ): Promise<void> {
    const key = tokenLockKey(pos.chain, pos.tokenAddress);
    await this.withToken(key, () => this.closeUnlocked(pos, reason, alert, opts));
  }

  async closeToken(query: string): Promise<string> {
    const matches = this.store.findOpenByTokenQuery(query, this.env.dryRun);
    if (!matches.length) return `No open position matching ${query}`;
    for (const pos of matches) {
      await this.closePosition(pos, "manual_close");
    }
    return `Close requested for ${matches.length} position(s) matching ${query}`;
  }

  async writeOffToken(query: string): Promise<string> {
    const matches = this.store.findOpenByTokenQuery(query, this.env.dryRun);
    if (!matches.length) return `No open position matching ${query}`;
    for (const pos of matches) {
      const key = tokenLockKey(pos.chain, pos.tokenAddress);
      await this.withToken(key, async () => {
        this.store.markWrittenOff(pos.id, "manual_writeoff");
        this.store.deleteSellRetry(pos.id);
      });
    }
    return `Wrote off ${matches.length} position(s) matching ${query}. They no longer count toward maxOpenPositions.`;
  }

  /** Retry mirrored sells that failed after the trader event was already claimed. */
  async drainSellRetries(): Promise<void> {
    const due = this.store.dueSellRetries(Date.now());
    for (const row of due) {
      const pos = this.store.getPosition(row.positionId);
      if (!pos || (pos.status !== "open" && pos.status !== "dry_open")) {
        this.store.deleteSellRetry(row.positionId);
        continue;
      }
      await this.closePosition(
        pos,
        row.reason,
        undefined,
        row.ourFraction != null ? { fraction: row.ourFraction } : undefined,
      );
    }
  }

  private async withToken<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.heldTokens.has(key)) return fn();
    return this.tokens.runExclusive(key, async () => {
      this.heldTokens.add(key);
      try {
        return await fn();
      } finally {
        this.heldTokens.delete(key);
      }
    });
  }

  private fire(p: Promise<unknown>): void {
    void p.catch((err) => {
      log.warn(`telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private noteSkip(
    alert: NormalizedAlert,
    reason: SkipReason,
    detail?: string,
    opts?: { notify?: boolean; claim?: boolean },
  ): void {
    this.store.recordSkip({
      eventId: alert.eventId,
      reason,
      detail: detail ?? null,
      trader: alert.traderHandle ?? alert.userId,
      tokenAddress: alert.tokenAddress,
      side: alert.alertType,
      isDryRun: this.env.dryRun,
    });
    if (opts?.claim) this.store.claimEventStrict(alert.eventId);
    if (opts?.notify !== false && reason !== "already_processed") {
      this.fire(this.tg.notifySkip(alert, reason, detail));
    }
  }

  private async handleExclusive(
    alert: NormalizedAlert,
    opts?: { suppressBuy?: boolean },
  ): Promise<void> {
    if (alert.alertType === "buy" && opts?.suppressBuy) {
      log.info(
        `SKIP buy ${alert.tokenSymbol ?? "?"} @ ${alert.traderHandle}: same_batch_sell ${batchSellKey(alert)}`,
      );
      this.noteSkip(alert, "same_batch_sell", "trader sold this token in the same batch", {
        claim: true,
      });
      return;
    }

    const filtered = evaluateAlert(alert, {
      cfg: this.cfg,
      store: this.store,
      dryRun: this.env.dryRun,
      paused: this.kill.isPaused(),
      watchlist: this.watchlist,
    });

    if (!filtered.ok) {
      const reason = filtered.reason ?? "other";
      log.info(
        `SKIP ${alert.alertType} ${alert.tokenSymbol ?? "?"} @ ${alert.traderHandle}: ${reason} ${filtered.detail ?? ""}`,
      );
      this.noteSkip(alert, reason, filtered.detail, {
        notify: reason !== "already_processed",
        claim: CLAIM_ON_SKIP.has(reason),
      });
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

  private beginEntry(
    alert: NormalizedAlert,
    sizeUsd: number,
  ): { ok: true; hold: EntryHold } | { ok: false; reason: SkipReason; detail: string } {
    const dry = this.env.dryRun;
    const liveOnly = !dry;
    const traderKey = alert.userId ?? alert.traderHandle ?? "";
    const merging =
      this.cfg.sizing.mergeRebuys &&
      !this.cfg.filters.firstBuysOnly &&
      this.store.findOpenByTraderToken(traderKey, alert.tokenAddress!, alert.chain, {
        includeDryRun: !liveOnly,
      }) != null;
    const openCount = liveOnly
      ? this.store.countOpenLive()
      : this.store.listOpen({ includeDryRun: true }).length;
    let slot = false;
    if (!merging && openCount + this.reservedSlots >= this.cfg.risk.maxOpenPositions) {
      return {
        ok: false,
        reason: "max_positions",
        detail: `${openCount}+${this.reservedSlots} reserved / ${this.cfg.risk.maxOpenPositions}`,
      };
    }
    if (!merging) slot = true;

    const last = Math.max(
      this.store.lastEntryAt(traderKey) ?? 0,
      this.cooldownHold.get(traderKey) ?? 0,
    );
    if (last && this.cfg.risk.cooldownSeconds > 0) {
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < this.cfg.risk.cooldownSeconds) {
        return {
          ok: false,
          reason: "cooldown",
          detail: `${traderKey} ${Math.ceil(this.cfg.risk.cooldownSeconds - elapsed)}s left`,
        };
      }
    }

    const daily = this.store.getDaily();
    if (!dry && daily.spentUsd + this.reservedSpend + sizeUsd > this.cfg.risk.dailyBudgetUsd) {
      return {
        ok: false,
        reason: "daily_budget",
        detail: `spent ${daily.spentUsd}+reserved ${this.reservedSpend}+${sizeUsd} > ${this.cfg.risk.dailyBudgetUsd}`,
      };
    }
    const lossLimit = this.cfg.risk.dailyLossLimitUsd ?? 0;
    if (lossLimit > 0) {
      const pnl = dry ? daily.paperRealizedPnlUsd : daily.realizedPnlUsd;
      if (pnl <= -lossLimit) {
        return {
          ok: false,
          reason: "daily_loss_limit",
          detail: `realized ${pnl} <= -${lossLimit} (resets 00:00 UTC)`,
        };
      }
    }

    const now = Date.now();
    if (slot) this.reservedSlots += 1;
    if (!dry) this.reservedSpend += sizeUsd;
    this.cooldownHold.set(traderKey, now);
    return {
      ok: true,
      hold: { traderKey, spend: dry ? 0 : sizeUsd, slot, cooldownTs: now },
    };
  }

  private endEntry(hold: EntryHold, success: boolean, sizeUsd: number): void {
    if (hold.slot) this.reservedSlots = Math.max(0, this.reservedSlots - 1);
    if (hold.spend) this.reservedSpend = Math.max(0, this.reservedSpend - hold.spend);
    if (this.cooldownHold.get(hold.traderKey) === hold.cooldownTs) {
      this.cooldownHold.delete(hold.traderKey);
    }
    if (!success) return;
    if (!this.env.dryRun) this.store.addSpend(sizeUsd);
    this.store.setLastEntryAt(Date.now(), hold.traderKey);
  }

  private async copyBuy(alert: NormalizedAlert, sizeUsd: number): Promise<void> {
    const gate = await this.budget.runExclusive(async () => this.beginEntry(alert, sizeUsd));
    if (!gate.ok) {
      log.info(`SKIP buy ${alert.tokenSymbol}: ${gate.reason} ${gate.detail}`);
      this.noteSkip(alert, gate.reason, gate.detail);
      return;
    }

    let opened = false;
    try {
      opened = await this.executeBuy(alert, sizeUsd);
    } finally {
      await this.budget.runExclusive(async () => this.endEntry(gate.hold, opened, sizeUsd));
    }
  }

  private async executeBuy(alert: NormalizedAlert, sizeUsd: number): Promise<boolean> {
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
      const reason = execSkipReason(result.error);
      log.error(`Buy failed: ${result.error}`);
      this.noteSkip(alert, reason, result.error ? redactSecrets(result.error) : result.error);
      return false;
    }
    if (!dryRun && result.dryRun) {
      log.error("Buy returned dryRun result while LIVE — refusing to open position");
      if (pendingId) {
        this.store.updatePendingSwap(pendingId, {
          status: "unresolved",
          error: "live requested but executor dry-ran",
        });
      }
      this.noteSkip(alert, "execution_failed", "live requested but executor dry-ran");
      return false;
    }
    if (!result.outAmountRaw) {
      log.error("Buy succeeded but no outAmountRaw — refusing phantom position");
      if (pendingId) {
        this.store.updatePendingSwap(pendingId, {
          status: "unresolved",
          error: "missing outAmountRaw after confirmed swap",
          txSignature: result.txHash ?? null,
        });
        this.fire(
          this.tg.send(
            `<b>⚠️ Untracked fill</b>
Buy confirmed but outAmountRaw missing. pending=${pendingId} tx=${result.txHash ?? "?"}`,
          ),
        );
      }
      this.noteSkip(alert, "execution_failed", "missing outAmountRaw");
      return false;
    }

    const traderKey = alert.userId ?? alert.traderHandle ?? "";
    const existing =
      this.cfg.sizing.mergeRebuys && !this.cfg.filters.firstBuysOnly
        ? this.store.findOpenByTraderToken(traderKey, alert.tokenAddress!, alert.chain, {
            includeDryRun: dryRun,
          })
        : null;

    if (existing) {
      this.store.mergeIntoPosition(existing.id, {
        usd: sizeUsd,
        raw: result.outAmountRaw,
        usdIn: result.inUsd ?? sizeUsd,
        solInLamports: result.solInLamports ?? null,
        feeLamports: lamports(result.feeLamports),
        rentPaidLamports: lamports(result.rentLamports),
        traderSizeUsd: alert.tradeUsd,
        txEntry: result.txHash ?? null,
      });
      if (pendingId) this.store.markPendingReconciled(pendingId, existing.id);
      this.scheduleSnapshot(existing.id, traderKey, alert.tokenAddress!);
      this.fire(
        this.tg.notifyEntry({
          alert,
          sizeUsd,
          dryRun: result.dryRun,
          txHash: result.txHash,
          quoteSummary: `merge into ${existing.id} ${result.quoteSummary ?? ""}`.trim(),
        }),
      );
      return true;
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
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: alert.eventId,
      status: dryRun ? "dry_open" : "open",
      isDryRun: dryRun,
      txEntry: result.txHash ?? null,
      usdIn: result.inUsd ?? sizeUsd,
      solInLamports: result.solInLamports ?? null,
      feeLamports: lamports(result.feeLamports),
      rentPaidLamports: lamports(result.rentLamports),
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
        this.fire(
          this.tg.send(
            `<b>⚠️ Untracked fill</b>
Live buy succeeded but DB insert failed.\npending=<code>${pendingId}</code>\ntx=<code>${result.txHash ?? "?"}</code>\ntoken=<code>${alert.tokenAddress}</code>`,
          ),
        );
      }
      this.noteSkip(alert, "execution_failed", "db insert failed");
      return false;
    }

    if (pendingId) this.store.markPendingReconciled(pendingId, pos.id);
    this.scheduleSnapshot(pos.id, traderKey, alert.tokenAddress!);
    this.fire(
      this.tg.notifyEntry({
        alert,
        sizeUsd,
        dryRun: result.dryRun,
        txHash: result.txHash,
        quoteSummary: result.quoteSummary,
      }),
    );
    return true;
  }

  /** FOMO position snapshot is off the buy path so a slow read cannot delay the fill. */
  private scheduleSnapshot(posId: string, traderKey: string, token: string): void {
    if (!this.fomo || !traderKey) return;
    void this.fomo
      .positions(traderKey)
      .then((body) => {
        const amt = findTraderTokenAmount(body, token);
        if (amt != null) this.store.setTraderTokenAmount(posId, amt);
      })
      .catch((e) => {
        log.debug("trader position snapshot failed", e);
      });
  }

  private async copySell(alert: NormalizedAlert, traderKey: string): Promise<void> {
    const positions = this.positionsForTraderToken(alert, traderKey);
    if (!positions.length) {
      this.noteSkip(alert, "sell_without_our_position");
      return;
    }
    for (const pos of positions) {
      await this.closeUnlocked(pos, "trader_sell", alert);
    }
  }

  private positionsForTraderToken(alert: NormalizedAlert, traderKey: string): OpenPosition[] {
    const includeDry = this.env.dryRun;
    const map = new Map<string, OpenPosition>();
    const keys = [traderKey, alert.traderHandle, alert.userId].filter(
      (k): k is string => Boolean(k),
    );
    for (const key of keys) {
      for (const pos of this.store.listOpenByTraderToken(
        key,
        alert.tokenAddress!,
        alert.chain,
        { includeDryRun: includeDry },
      )) {
        map.set(pos.id, pos);
      }
    }
    return [...map.values()];
  }

  private async closeUnlocked(
    pos: OpenPosition,
    reason: string,
    alert?: NormalizedAlert,
    opts?: { fraction?: number },
  ): Promise<void> {
    const dryRun = this.env.dryRun || pos.isDryRun;
    const locked = this.store.claimPositionForClose(pos.id);
    if (!locked) {
      log.info(`Position ${pos.id} already closing/closed — skip`);
      return;
    }

    let fraction = opts?.fraction ?? 1;
    let fractionMethod = "full";
    let fractionDetail = reason;
    let armTrail = false;
    let nextTraderTokenAmount: number | null = null;
    if (reason === "trader_sell" && opts?.fraction == null) {
      const resolved = await resolveSellFraction({
        pos: locked,
        alert,
        fomo: this.fomo,
      });
      nextTraderTokenAmount = resolved.nextTraderTokenAmount;
      const mapped = mapTraderSellToOurFraction(resolved.fraction);
      fractionMethod = resolved.method;
      fractionDetail = `${resolved.detail}. ${mapped.detail}`;
      const logLine = `Mirror sell method=${fractionMethod} traderFraction=${resolved.fraction ?? "unknown"} ourFraction=${mapped.ourFraction} (${fractionDetail})`;
      if (resolved.fraction == null) log.warn(logLine);
      else log.info(logLine);
      if (mapped.action === "ignore") {
        if (nextTraderTokenAmount != null) {
          this.store.setTraderTokenAmount(locked.id, nextTraderTokenAmount);
        }
        this.store.revertClosingToOpen(pos.id);
        log.info(`Ignored trader sell under 10% for ${locked.tokenSymbol ?? locked.tokenAddress}`);
        return;
      }
      fraction = mapped.ourFraction;
      armTrail = mapped.armTrail && !locked.trailArmed;
      this.fire(
        this.tg.notifySellSizing({
          method: fractionMethod,
          fraction,
          detail: fractionDetail,
        }),
      );
    } else if (reason === "trader_sell" && opts?.fraction != null) {
      // Retry keeps the fraction decided on the first attempt. The alert is gone.
      fraction = opts.fraction;
      fractionMethod = "retry";
      fractionDetail = `retry ourFraction=${opts.fraction}`;
      armTrail = opts.fraction < 0.999 && !locked.trailArmed;
      this.fire(
        this.tg.notifySellSizing({
          method: fractionMethod,
          fraction,
          detail: fractionDetail,
        }),
      );
    } else if (opts?.fraction != null && opts.fraction < 0.999) {
      fractionMethod = "partial";
      fractionDetail = `fraction=${opts.fraction}`;
    }

    if (!locked.quantityRaw) {
      log.error(`Sell aborted: position ${pos.id} has no quantityRaw`);
      this.store.revertClosingToOpen(pos.id);
      if (alert) this.noteSkip(alert, "execution_failed", "no quantityRaw");
      this.noteMirroredFailure(locked, reason, alert, "no quantityRaw", fraction);
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

    const ladder =
      this.cfg.risk.sellSlippageBps?.length > 0
        ? this.cfg.risk.sellSlippageBps
        : [this.cfg.risk.maxSlippageBps];
    let result: SwapResult | undefined;
    for (const bps of ladder) {
      result = await this.exec.sell(locked.chain, {
        sellToken: locked.tokenAddress,
        buyToken: "",
        sellUsd: locked.remainingUsd * fraction,
        sellAmountRaw: sellRaw,
        slippageBps: bps,
        dryRun,
      });
      if (result.ok) break;
      log.warn(
        `Sell ${locked.tokenSymbol ?? locked.tokenAddress} at ${bps}bps failed: ${result.error ?? "unknown"}`,
      );
    }

    if (!result || !result.ok) {
      const err = result?.error ?? "sell failed";
      log.error(`Sell failed: ${err}`);
      this.store.revertClosingToOpen(pos.id);
      if (alert) this.noteSkip(alert, "execution_failed", redactSecrets(err));
      this.noteMirroredFailure(locked, reason, alert, err, fraction);
      return;
    }
    if (!dryRun && result.dryRun) {
      log.error("Sell returned dryRun while LIVE — reverting lock");
      this.store.revertClosingToOpen(pos.id);
      if (alert) this.noteSkip(alert, "execution_failed", "live sell dry-ran");
      this.noteMirroredFailure(locked, reason, alert, "live sell dry-ran", fraction);
      return;
    }

    const exitUsd = result.outUsd ?? locked.remainingUsd * fraction;
    const costBasis = locked.remainingUsd * fraction;
    const pnl = exitUsd - costBasis;
    const fullyClosed = fraction >= 0.999 || sellRaw === locked.quantityRaw;
    const remainingRaw = fullyClosed
      ? "0"
      : (BigInt(locked.quantityRaw) - BigInt(sellRaw)).toString();
    const remainingUsd = fullyClosed ? 0 : Math.max(0, locked.remainingUsd * (1 - fraction));

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
    this.store.addFillEconomics(locked.id, {
      usdOutDelta: exitUsd,
      solOutLamports: result.solOutLamports ?? null,
      feeLamports: lamports(result.feeLamports),
    });
    if (nextTraderTokenAmount != null) {
      this.store.setTraderTokenAmount(locked.id, nextTraderTokenAmount);
    }
    if (!fullyClosed && armTrail) {
      this.store.setTrailArmed(locked.id);
    }
    this.store.deleteSellRetry(locked.id);

    if (dryRun) this.store.addPaperRealizedPnl(pnl);
    else this.store.addRealizedPnl(pnl);

    if (
      fullyClosed &&
      !dryRun &&
      locked.chain === "solana" &&
      this.cfg.risk.closeEmptyTokenAccount &&
      typeof this.exec.reclaimRent === "function"
    ) {
      try {
        const rec = await this.exec.reclaimRent(locked.chain, locked.tokenAddress);
        if (rec.rentLamports && rec.rentLamports > 0) {
          this.store.addFillEconomics(locked.id, {
            rentReclaimedLamports: String(Math.round(rec.rentLamports)),
          });
          log.info(`Reclaimed ${rec.rentLamports} lamports from ${locked.tokenSymbol ?? locked.tokenAddress}`);
        } else if (!rec.ok && rec.error) {
          log.warn(`ATA close skipped for ${locked.tokenAddress}: ${rec.error}`);
        }
      } catch (e) {
        log.warn(
          `ATA close failed for ${locked.tokenAddress}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const daily = this.store.getDaily();
    const todayPnl = dryRun ? daily.paperRealizedPnlUsd : daily.realizedPnlUsd;
    this.fire(
      this.tg.notifyExit({
        pos: locked,
        reason: fullyClosed
          ? `${reason} (${fractionMethod})`
          : `${reason}_partial_${(fraction * 100).toFixed(1)}pct (${fractionMethod})`,
        exitUsd,
        pnlUsd: pnl,
        dryRun,
        txHash: result.txHash,
      }),
    );
    this.fire(
      this.tg.notifyPnl(
        `${fullyClosed ? "Closed" : "Partial"} ${locked.tokenSymbol ?? locked.tokenAddress} (${reason}/${fractionMethod}): ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}. Today realized: $${todayPnl.toFixed(2)}`,
      ),
    );
  }

  private noteMirroredFailure(
    pos: OpenPosition,
    reason: string,
    alert: NormalizedAlert | undefined,
    error: string,
    ourFraction: number,
  ): void {
    if (!MIRRORED_SELL.has(reason)) return;
    const max = this.cfg.risk.mirroredSellMaxRetries;
    const prev = this.store.getSellRetry(pos.id);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (attempts >= max) {
      this.store.deleteSellRetry(pos.id);
      log.warn(
        `Mirrored sell gave up on ${pos.tokenSymbol ?? pos.id} after ${attempts} attempts: ${error}`,
      );
      this.fire(
        this.tg.send(
          `<b>Mirrored sell gave up</b>\n${pos.tokenSymbol ?? pos.tokenAddress} after ${attempts} attempts.\n${redactSecrets(error).slice(0, 300)}\nPosition stays open for stop-loss and the trailing stop.`,
        ),
      );
      return;
    }
    const delay = Math.min(60_000, 5_000 * attempts);
    this.store.upsertSellRetry({
      positionId: pos.id,
      eventId: alert?.eventId ?? prev?.eventId ?? null,
      reason,
      attempts,
      lastError: redactSecrets(error).slice(0, 500),
      nextAttemptAt: Date.now() + delay,
      ourFraction: prev?.ourFraction ?? ourFraction,
    });
    log.warn(
      `Queued mirrored sell retry ${attempts}/${max} for ${pos.tokenSymbol ?? pos.id} in ${delay}ms`,
    );
  }
}

function lamports(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return String(Math.round(value));
}

function execSkipReason(error: string | undefined): SkipReason {
  if (!error) return "execution_failed";
  if (error.startsWith("round_trip")) return "round_trip";
  if (error.startsWith("overhead")) return "overhead";
  if (error.startsWith("token_safety")) return "token_safety";
  if (error.startsWith("chase_limit")) return "chase_limit";
  return "execution_failed";
}
