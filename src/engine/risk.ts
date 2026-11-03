import type { AppConfig, OpenPosition } from "../types.js";
import type { Store } from "../store/db.js";
import type { ExecutionRouter } from "../execution/index.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import { log } from "../utils/logger.js";
import { ZEROX_NATIVE_ETH } from "../utils/money.js";

export type TpSlHandler = (
  pos: OpenPosition,
  reason: "take_profit" | "stop_loss",
  markUsd: number,
) => Promise<void>;

/**
 * Periodic TP/SL. Mark = sell-quote outUsd, or raw outAmount × fresh native/USDC price.
 * Notifies Telegram when mark still cannot be computed.
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
    void tick(opts).finally(() => {
      running = false;
    });
  }, ms);
}

async function tick(opts: {
  cfg: AppConfig;
  store: Store;
  exec: ExecutionRouter;
  dryRun: boolean;
  onTrigger: TpSlHandler;
  tg?: TelegramNotifier;
}): Promise<void> {
  const tp = opts.cfg.risk.takeProfitPct;
  const sl = opts.cfg.risk.stopLossPct;
  if (tp <= 0 && sl <= 0) return;

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
      if (!quote.ok) continue;

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
        const sym = (pos.tokenSymbol ?? pos.tokenAddress).replace(/[<>&]/g, "");
        const msg = `TP/SL skip ${sym}: no outUsd from quote/price`;
        log.warn(msg);
        await opts.tg?.send(`<b>⚠️ TP/SL skipped</b>\n${msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`);
        continue;
      }

      const pnlPct = ((markUsd - pos.remainingUsd) / pos.remainingUsd) * 100;
      if (tp > 0 && pnlPct >= tp) {
        log.info(`TP hit ${pos.tokenSymbol} pnlPct=${pnlPct.toFixed(1)}`);
        await opts.onTrigger(pos, "take_profit", markUsd);
      } else if (sl > 0 && pnlPct <= -sl) {
        log.info(`SL hit ${pos.tokenSymbol} pnlPct=${pnlPct.toFixed(1)}`);
        await opts.onTrigger(pos, "stop_loss", markUsd);
      }
    } catch (e) {
      log.debug(`TP/SL check failed for ${pos.id}`, e);
    }
  }
}
