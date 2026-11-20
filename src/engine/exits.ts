import type { AppConfig, OpenPosition } from "../types.js";

export type ExitReason = "stop_loss" | "trailing_stop" | "max_hold";

export type ExitDecision =
  | { type: "hold" }
  | { type: "seed_peak"; markUsd: number }
  | { type: "close"; reason: ExitReason; fraction: number };

/**
 * Stop-loss is always a full exit from cost basis.
 * The trailing stop runs only after a partial mirrored sell has set trailArmed,
 * and it measures the drop from the highest mark since that arming.
 * There is no fixed take-profit.
 */
export function decideExit(opts: {
  pos: OpenPosition;
  markUsd: number;
  cfg: AppConfig;
  nowMs?: number;
}): ExitDecision {
  const { pos, markUsd, cfg } = opts;
  const now = opts.nowMs ?? Date.now();
  const cost = pos.remainingUsd;
  if (!(cost > 0) || !(markUsd >= 0)) return { type: "hold" };

  const maxHold = cfg.risk.maxHoldMinutes;
  if (maxHold > 0) {
    const opened = Date.parse(pos.openedAt);
    if (Number.isFinite(opened) && now - opened >= maxHold * 60_000) {
      return { type: "close", reason: "max_hold", fraction: 1 };
    }
  }

  const pnlPct = ((markUsd - cost) / cost) * 100;
  const sl = cfg.risk.stopLossPct;
  const trail = cfg.risk.trailingStopPct;

  if (sl > 0 && pnlPct <= -sl) {
    return { type: "close", reason: "stop_loss", fraction: 1 };
  }

  if (pos.trailArmed && trail > 0) {
    if (pos.peakMarkUsd == null || !(pos.peakMarkUsd > 0)) {
      return { type: "seed_peak", markUsd };
    }
    if (markUsd > pos.peakMarkUsd) {
      return { type: "seed_peak", markUsd };
    }
    const dropPct = ((pos.peakMarkUsd - markUsd) / pos.peakMarkUsd) * 100;
    if (dropPct >= trail) {
      return { type: "close", reason: "trailing_stop", fraction: 1 };
    }
  }

  return { type: "hold" };
}

export function shouldWriteOffQuoteFailures(failures: number, limit: number): boolean {
  return limit > 0 && failures >= limit;
}
