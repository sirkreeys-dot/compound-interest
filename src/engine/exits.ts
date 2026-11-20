import type { AppConfig, OpenPosition } from "../types.js";

export type ExitReason = "take_profit" | "stop_loss" | "trailing_stop" | "max_hold";

export type ExitDecision =
  | { type: "hold" }
  | { type: "seed_peak"; markUsd: number }
  | { type: "close"; reason: ExitReason; fraction: number };

/**
 * Pure TP1 / trailing / stop / max-hold decision for one marked position.
 * Stop-loss is always a full exit. TP1 sells takeProfitSellFraction (default half)
 * and arms the trailing stop on whatever remains. Max hold is a full exit.
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
  const tp = cfg.risk.takeProfitPct;
  const trail = cfg.risk.trailingStopPct;
  const tpFraction = cfg.risk.takeProfitSellFraction;

  if (sl > 0 && pnlPct <= -sl) {
    return { type: "close", reason: "stop_loss", fraction: 1 };
  }

  if (!pos.tp1Done && tp > 0 && pnlPct >= tp) {
    const fraction = tpFraction > 0 && tpFraction < 0.999 ? tpFraction : 1;
    return { type: "close", reason: "take_profit", fraction };
  }

  const trailArmed = Boolean(pos.tp1Done) || (tp <= 0 && trail > 0);
  if (trailArmed && trail > 0) {
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
