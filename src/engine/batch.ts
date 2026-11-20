import type { ChainName, NormalizedAlert } from "../types.js";

/** Lock and dedupe key for one token on one chain. */
export function tokenLockKey(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`;
}

/** Trader + token identity used to match a buy with a sell in the same batch. */
export function batchSellKey(alert: {
  userId: string | null;
  traderHandle: string | null;
  tokenAddress: string | null;
  chain: ChainName | string;
}): string {
  const trader = (alert.userId ?? alert.traderHandle ?? "").toLowerCase();
  const token = (alert.tokenAddress ?? "").toLowerCase();
  return `${trader}|${alert.chain}|${token}`;
}

/** Event ids of buys that should be skipped because that trader sold the token in this batch. */
export function buysSuppressedBySameBatch(alerts: NormalizedAlert[]): Set<string> {
  const sells = new Set<string>();
  for (const alert of alerts) {
    if (alert.alertType === "sell" && alert.tokenAddress) sells.add(batchSellKey(alert));
  }
  const suppressed = new Set<string>();
  for (const alert of alerts) {
    if (alert.alertType !== "buy" || !alert.tokenAddress) continue;
    if (sells.has(batchSellKey(alert))) suppressed.add(alert.eventId);
  }
  return suppressed;
}
