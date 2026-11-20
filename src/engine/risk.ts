import type { AppConfig, OpenPosition } from "../types.js";
import type { Store } from "../store/db.js";
import type { ExecutionRouter } from "../execution/index.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import { log } from "../utils/logger.js";
import { ZEROX_NATIVE_ETH } from "../utils/money.js";
import { decideExit, shouldWriteOffQuoteFailures, type ExitReason } from "./exits.js";

export type TpSlHandler = (
  pos: OpenPosition,
  reason: ExitReason,
  markUsd: number,
  fraction: number,
) => Promise<void>;

/**
 * Periodic exits: stop-loss, trailing stop once a partial mirror has armed it, max hold.
 * Mark = sell-quote outUsd, or raw outAmount × fresh native/USDC price.
 * Quote failures are counted; after quoteFailWriteoffCount the position is written
 * off and stops counting toward maxOpenPositions.
 */
export function startTpSlLoop(opts: {
  cfg: AppConfig;
  store: Store;
  exec: ExecutionRouter;
  dryRun: boolean;
  onTrigger: TpSlHandler;
  tg?: TelegramNotifier;
}): NodeJS.Timeout {
  const ms = opts.cfg.poll.tpSlCheckIntervalSec * 1000;
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runTpSlPass(opts).finally(() => {
      running = false;
    });
  }, ms);
}

export async function runTpSlPass(opts: {
  cfg: AppConfig;
  store: Store;
  exec: ExecutionRouter;
  dryRun: boolean;
  onTrigger: TpSlHandler;
  tg?: TelegramNotifier;
}): Promise<void> {
  const sl = opts.cfg.risk.stopLossPct;
  const trail = opts.cfg.risk.trailingStopPct;
  const hold = opts.cfg.risk.maxHoldMinutes;
  if (sl <= 0 && trail <= 0 && hold <= 0) return;

  const positions = opts.store.listOpen({ includeDryRun: opts.dryRun });
  for (const pos of positions) {
    if (!pos.quantityRaw || pos.remainingUsd <= 0) continue;
    const ex = opts.exec.forChain(pos.chain);
    if (!ex) continue;
    try {
      const quote = await ex.sellToken({
        chain: pos.chain,
        sellToken: pos.tokenAddress,
        buyToken: "",
        sellUsd: pos.remainingUsd,
        sellAmountRaw: pos.quantityRaw,
        slippageBps: opts.cfg.risk.maxSlippageBps,
        dryRun: true,
      });
      if (!quote.ok) {
        noteQuoteFailure(opts, pos, quote.error ?? "quote failed");
        continue;
      }

      let markUsd = quote.outUsd ?? null;
      if (markUsd == null && quote.outAmountRaw) {
        const buyToken =
          pos.chain === "solana"
            ? opts.cfg.quote.solanaNative
            : ZEROX_NATIVE_ETH;
        const valued = await opts.exec.prices.rawOutToUsd({
          chain: pos.chain === "base" ? "base" : "solana",
          buyToken,
          outAmountRaw: quote.outAmountRaw,
        });
        markUsd = valued?.usd ?? null;
        if (valued) log.debug(`TP/SL mark via ${valued.source}=$${valued.usd}`);
      }

      if (markUsd == null) {
        noteQuoteFailure(opts, pos, "no outUsd from quote/price");
        const sym = (pos.tokenSymbol ?? pos.tokenAddress).replace(/[<>&]/g, "");
        const msg = `TP/SL skip ${sym}: no outUsd from quote/price`;
        log.warn(msg);
        await opts.tg?.send(
          `<b>⚠️ TP/SL skipped</b>\n${msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`,
        );
        continue;
      }

      opts.store.resetQuoteFailures(pos.id);
      const fresh = opts.store.getPosition(pos.id) ?? pos;
      const decision = decideExit({ pos: fresh, markUsd, cfg: opts.cfg });
      if (decision.type === "seed_peak") {
        opts.store.setPeakMark(pos.id, decision.markUsd);
        continue;
      }
      if (decision.type === "close") {
        log.info(
          `${decision.reason} ${pos.tokenSymbol} mark=$${markUsd.toFixed(4)} fraction=${decision.fraction}`,
        );
        await opts.onTrigger(fresh, decision.reason, markUsd, decision.fraction);
      }
    } catch (e) {
      log.warn(
        `TP/SL check failed for ${pos.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

function noteQuoteFailure(
  opts: { cfg: AppConfig; store: Store },
  pos: OpenPosition,
  detail: string,
): void {
  const n = opts.store.bumpQuoteFailures(pos.id);
  const limit = opts.cfg.risk.quoteFailWriteoffCount;
  log.warn(
    `TP/SL quote failed for ${pos.tokenSymbol ?? pos.id} (${n}/${limit}): ${detail}`,
  );
  if (shouldWriteOffQuoteFailures(n, limit)) {
    opts.store.markWrittenOff(pos.id, `quote_failures:${n}`);
    log.warn(
      `Wrote off ${pos.tokenSymbol ?? pos.tokenAddress} after ${n} failed quotes — no longer counts toward maxOpenPositions`,
    );
  }
}
