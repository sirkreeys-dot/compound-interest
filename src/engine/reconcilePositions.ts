import type { FomoRestClient } from "../fomo/client.js";
import type { AppConfig, OpenPosition } from "../types.js";
import type { Store } from "../store/db.js";
import { log } from "../utils/logger.js";
import { traderHoldState } from "./sellFraction.js";

/**
 * Compare our open positions to each trader's FOMO book.
 * A positions read that fails or cannot be parsed does not flatten anything:
 * a blip must not market-sell the book. The next cycle retries.
 * A parsed book that no longer contains the token (or shows it closed / zero) does.
 */
export async function reconcileOpenPositions(opts: {
  store: Store;
  fomo: FomoRestClient;
  includeDryRun: boolean;
  onFlat: (pos: OpenPosition) => Promise<void>;
}): Promise<{ checked: number; flat: number; skipped: number }> {
  const open = opts.store.listOpen({ includeDryRun: opts.includeDryRun });
  if (!open.length) return { checked: 0, flat: 0, skipped: 0 };

  const byTrader = new Map<string, OpenPosition[]>();
  for (const pos of open) {
    const key = pos.traderUserId ?? pos.traderHandle;
    if (!key) continue;
    const list = byTrader.get(key) ?? [];
    list.push(pos);
    byTrader.set(key, list);
  }

  let checked = 0;
  let flat = 0;
  let skipped = 0;
  for (const [trader, positions] of byTrader) {
    let body: unknown;
    try {
      body = await opts.fomo.positions(trader);
    } catch (e) {
      skipped += positions.length;
      log.warn(
        `position reconcile skipped ${trader}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    for (const pos of positions) {
      checked++;
      const state = traderHoldState(body, pos.tokenAddress);
      if (state === "unknown") {
        skipped++;
        log.warn(`position reconcile unreadable book for ${trader} token ${pos.tokenAddress}`);
        continue;
      }
      if (state === "flat") {
        flat++;
        log.info(
          `position reconcile: ${trader} flat on ${pos.tokenSymbol ?? pos.tokenAddress} — exiting`,
        );
        await opts.onFlat(pos);
      }
    }
  }
  return { checked, flat, skipped };
}

export function startPositionReconcileLoop(opts: {
  cfg: AppConfig;
  store: Store;
  fomo: FomoRestClient | null;
  includeDryRun: boolean;
  onFlat: (pos: OpenPosition) => Promise<void>;
}): { stop: () => void } | null {
  const sec = opts.cfg.poll.positionReconcileIntervalSec;
  if (!opts.fomo || !(sec > 0)) return null;
  const fomo = opts.fomo;
  let running = false;
  let stopped = false;
  const run = () => {
    if (running || stopped) return;
    running = true;
    void reconcileOpenPositions({
      store: opts.store,
      fomo,
      includeDryRun: opts.includeDryRun,
      onFlat: opts.onFlat,
    })
      .catch((e) => {
        log.warn(
          `position reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };
  // One pass shortly after boot catches sells missed while the process was down.
  const starter = setTimeout(run, 5_000);
  const timer = setInterval(run, sec * 1000);
  timer.unref?.();
  starter.unref?.();
  log.info(
    `Position reconcile every ${sec}s (250 FOMO credits per trader with an open position; 0 disables)`,
  );
  return {
    stop: () => {
      stopped = true;
      clearTimeout(starter);
      clearInterval(timer);
    },
  };
}
