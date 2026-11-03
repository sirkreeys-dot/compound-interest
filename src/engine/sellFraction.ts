/**
 * Compute what fraction of OUR bag to sell when the copied trader sells.
 * Prefer FOMO /positions (documented fields) over alert heuristics.
 *
 * FOMO GET /v2/users/{handle|userId}/positions rows include:
 *   token.{symbol,address}, status open|closed, amount, boughtAmount, soldAmount,
 *   costBasisUsd, …
 */
import type { NormalizedAlert, OpenPosition } from "../types.js";
import type { FomoRestClient } from "../fomo/client.js";
import { sellFraction as heuristicFraction } from "../utils/money.js";
import { log } from "../utils/logger.js";

export type SellFractionMethod =
  | "fomo_position_delta"
  | "fomo_fully_closed"
  | "fomo_sold_vs_bought"
  | "alert_trade_usd"
  | "full_exit_fallback";

export interface SellFractionResult {
  fraction: number;
  method: SellFractionMethod;
  detail: string;
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
        if (row.status === "closed" || (typeof row.amount === "number" && row.amount <= 0)) {
          return {
            fraction: 1,
            method: "fomo_fully_closed",
            detail: `FOMO status=${row.status} amount=${row.amount}`,
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
              detail: `entryAmt=${entryAmt} now=${row.amount} sold=${sold}`,
            };
          }
        }

        // Do NOT use cumulative soldAmount/boughtAmount without an entry snapshot.
        // Those fields are lifetime totals and can massively over-sell relative to
        // what the trader held when WE entered. Prefer alert heuristic / full exit.
      } else if (body.available !== false && rows.length >= 0) {
        // Token gone from open positions list → treat as full close
        const openOnly = rows.filter((r) => r.status === "open");
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
          };
        }
      }
    } catch (e) {
      log.warn("FOMO positions lookup for sell fraction failed", e);
    }
  }

  const heur = heuristicFraction({
    traderSellUsd: alert?.tradeUsd ?? null,
    traderSizeAtEntryUsd: pos.traderSizeAtEntryUsd,
  });
  if (
    alert?.tradeUsd != null &&
    alert.tradeUsd > 0 &&
    pos.traderSizeAtEntryUsd != null &&
    pos.traderSizeAtEntryUsd > 0 &&
    heur < 1
  ) {
    return {
      fraction: heur,
      method: "alert_trade_usd",
      detail: `tradeUsd=${alert.tradeUsd} traderSizeAtEntryUsd=${pos.traderSizeAtEntryUsd}`,
    };
  }

  return {
    fraction: 1,
    method: "full_exit_fallback",
    detail: "no reliable FOMO/alert fraction — full exit",
  };
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
