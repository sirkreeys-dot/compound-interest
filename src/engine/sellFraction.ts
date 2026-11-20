/**
 * How much of the TRADER's position this sell represents.
 * The copy engine maps that number onto our bag (ignore / sell half / sell all).
 * It does not itself decide how much of our bag to sell.
 *
 * Order:
 * 1. FOMO positions: closed, amount <= 0, or the token missing from the open list → 100%.
 * 2. FOMO token amount vs the last amount we stored (entry snapshot, then the
 *    post-sell amount once we have seen one): (previous - current) / previous.
 *    Lifetime soldAmount/boughtAmount are never used.
 * 3. Alert tradeUsd / the position USD we stored at entry (`traderSizeAtEntryUsd`),
 *    capped at 1. That is this fill versus the size recorded when we copied,
 *    not versus a remaining balance we have reduced ourselves.
 * 4. Alert tradeUsd / (tradeUsd + positionValueUsd) when we have no stored size.
 *    positionValueUsd is treated as the value still open after the sell.
 * 5. Otherwise fraction is null (undetermined). Callers must not invent a full exit.
 *
 * FOMO GET /v2/users/{handle|userId}/positions rows include:
 *   token.{symbol,address}, status open|closed, amount, boughtAmount, soldAmount,
 *   costBasisUsd, …
 */
import type { NormalizedAlert, OpenPosition } from "../types.js";
import type { FomoRestClient } from "../fomo/client.js";
import { log } from "../utils/logger.js";

export type SellFractionMethod =
  | "fomo_position_delta"
  | "fomo_fully_closed"
  | "alert_trade_usd"
  | "alert_trade_vs_remaining"
  | "unknown";

export interface SellFractionResult {
  /** Share of the trader's position this sell represents. null = undetermined. */
  fraction: number | null;
  method: SellFractionMethod;
  detail: string;
  /** Persist this as the next baseline when FOMO reported a current token amount. */
  nextTraderTokenAmount: number | null;
}

/** Map the trader's sell, as a fraction of their position, onto our remaining bag. */
export function mapTraderSellToOurFraction(traderFraction: number | null): {
  action: "ignore" | "sell";
  ourFraction: number;
  /** Arm the trailing stop when this is the first partial mirror. */
  armTrail: boolean;
  detail: string;
} {
  if (traderFraction == null || !Number.isFinite(traderFraction)) {
    return {
      action: "sell",
      ourFraction: 0.5,
      armTrail: true,
      detail: "trader sell fraction unknown — selling 50% of our remaining position",
    };
  }
  const f = Math.min(1, Math.max(0, traderFraction));
  if (f < 0.1) {
    return {
      action: "ignore",
      ourFraction: 0,
      armTrail: false,
      detail: `trader sold ${(f * 100).toFixed(2)}% of their position (< 10%) — ignored`,
    };
  }
  // 99.9%+ counts as a full exit so a closed position is not left as a partial.
  if (f >= 0.999) {
    return {
      action: "sell",
      ourFraction: 1,
      armTrail: false,
      detail: `trader sold ${(f * 100).toFixed(2)}% — full exit, selling 100% of ours`,
    };
  }
  return {
    action: "sell",
    ourFraction: 0.5,
    armTrail: true,
    detail: `trader sold ${(f * 100).toFixed(2)}% (>= 10% and < 100%) — selling 50% of our remaining`,
  };
}

type PosRow = {
  token?: { symbol?: string; address?: string };
  status?: string;
  amount?: number;
  boughtAmount?: number;
  soldAmount?: number;
  costBasisUsd?: number;
};

export async function resolveSellFraction(opts: {
  pos: OpenPosition;
  alert?: NormalizedAlert;
  fomo: FomoRestClient | null;
}): Promise<SellFractionResult> {
  const { pos, alert, fomo } = opts;
  const traderKey = pos.traderUserId ?? pos.traderHandle;
  let seenAmount: number | null = null;

  if (fomo && traderKey && pos.tokenAddress) {
    try {
      const body = (await fomo.positions(traderKey)) as {
        available?: boolean;
        positions?: PosRow[];
        trades?: PosRow[]; // older name
      };
      const rows = Array.isArray(body.positions)
        ? body.positions
        : Array.isArray(body.trades)
          ? body.trades
          : [];
      const row = rows.find(
        (r) =>
          r.token?.address &&
          r.token.address.toLowerCase() === pos.tokenAddress.toLowerCase(),
      );

      if (row) {
        if (typeof row.amount === "number" && Number.isFinite(row.amount)) {
          seenAmount = row.amount;
        }
        if (row.status === "closed" || (typeof row.amount === "number" && row.amount <= 0)) {
          return {
            fraction: 1,
            method: "fomo_fully_closed",
            detail: `FOMO status=${row.status} amount=${row.amount}`,
            nextTraderTokenAmount: 0,
          };
        }

        const entryAmt = pos.traderTokenAmountAtEntry;
        if (
          entryAmt != null &&
          entryAmt > 0 &&
          typeof row.amount === "number" &&
          row.amount >= 0
        ) {
          const sold = Math.max(0, entryAmt - row.amount);
          const frac = Math.min(1, sold / entryAmt);
          if (frac > 0) {
            return {
              fraction: frac,
              method: "fomo_position_delta",
              detail: `previous=${entryAmt} now=${row.amount} sold=${sold} (${(frac * 100).toFixed(2)}% of last observed position)`,
              nextTraderTokenAmount: row.amount,
            };
          }
        }

        // Do NOT use cumulative soldAmount/boughtAmount. Those are lifetime totals.
      } else if (body.available !== false) {
        const openOnly = rows.filter((r) => r.status === "open" || r.status == null);
        const still = openOnly.find(
          (r) =>
            r.token?.address &&
            r.token.address.toLowerCase() === pos.tokenAddress.toLowerCase(),
        );
        if (!still) {
          return {
            fraction: 1,
            method: "fomo_fully_closed",
            detail: "token not in FOMO open positions",
            nextTraderTokenAmount: 0,
          };
        }
      }
    } catch (e) {
      log.warn("FOMO positions lookup for sell fraction failed", e);
    }
  }

  if (
    alert?.tradeUsd != null &&
    alert.tradeUsd > 0 &&
    pos.traderSizeAtEntryUsd != null &&
    pos.traderSizeAtEntryUsd > 0
  ) {
    const frac = Math.min(1, alert.tradeUsd / pos.traderSizeAtEntryUsd);
    return {
      fraction: frac,
      method: "alert_trade_usd",
      detail: `tradeUsd=${alert.tradeUsd} / traderSizeAtEntryUsd=${pos.traderSizeAtEntryUsd} = ${(frac * 100).toFixed(2)}% of the position USD recorded at our entry`,
      nextTraderTokenAmount: seenAmount,
    };
  }

  if (
    alert?.tradeUsd != null &&
    alert.tradeUsd > 0 &&
    alert.positionValueUsd != null &&
    alert.positionValueUsd > 0
  ) {
    const frac = Math.min(1, alert.tradeUsd / (alert.tradeUsd + alert.positionValueUsd));
    return {
      fraction: frac,
      method: "alert_trade_vs_remaining",
      detail: `tradeUsd=${alert.tradeUsd} / (tradeUsd + positionValueUsd ${alert.positionValueUsd}) = ${(frac * 100).toFixed(2)}% (positionValueUsd treated as value still open)`,
      nextTraderTokenAmount: seenAmount,
    };
  }

  return {
    fraction: null,
    method: "unknown",
    detail: "no FOMO token delta and no usable alert USD — fraction undetermined",
    nextTraderTokenAmount: seenAmount,
  };
}

/**
 * Whether the trader still holds `tokenAddress` according to a FOMO positions body.
 * `unknown` means the payload could not be trusted — callers must not flatten on it.
 * A token missing from a parsed positions array is `flat` (the same assumption the
 * sell-fraction path already uses).
 */
export function traderHoldState(
  body: unknown,
  tokenAddress: string,
): "open" | "flat" | "unknown" {
  if (!body || typeof body !== "object") return "unknown";
  const b = body as { available?: boolean; positions?: PosRow[]; trades?: PosRow[] };
  if (b.available === false) return "unknown";
  const rows = Array.isArray(b.positions)
    ? b.positions
    : Array.isArray(b.trades)
      ? b.trades
      : null;
  if (!rows) return "unknown";
  const addr = tokenAddress.toLowerCase();
  const row = rows.find((r) => r.token?.address && r.token.address.toLowerCase() === addr);
  if (!row) return "flat";
  if (row.status === "closed") return "flat";
  if (typeof row.amount === "number" && row.amount <= 0) return "flat";
  return "open";
}

/** Parse trader token amount from a FOMO positions response for one mint. */
export function findTraderTokenAmount(
  body: unknown,
  tokenAddress: string,
): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { positions?: PosRow[]; trades?: PosRow[] };
  const rows = Array.isArray(b.positions)
    ? b.positions
    : Array.isArray(b.trades)
      ? b.trades
      : [];
  const row = rows.find(
    (r) =>
      r.token?.address &&
      r.token.address.toLowerCase() === tokenAddress.toLowerCase() &&
      (r.status === "open" || r.status == null),
  );
  if (!row || typeof row.amount !== "number") return null;
  return row.amount;
}
