/** Safe-ish float → integer raw units (floor). */
export function usdToTokenRaw(usd: number, decimals: number, priceUsd: number): string | null {
  if (!(usd > 0) || !(priceUsd > 0) || decimals < 0 || decimals > 18) return null;
  const tokens = usd / priceUsd;
  const raw = tokens * 10 ** decimals;
  if (!Number.isFinite(raw) || raw < 1) return null;
  // Avoid scientific notation for large ints
  return BigInt(Math.floor(raw)).toString();
}

export function rawToUsd(raw: string, decimals: number, priceUsd: number): number | null {
  if (!(priceUsd > 0) || decimals < 0) return null;
  try {
    const r = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = Number(r / base);
    const frac = Number(r % base) / Number(base);
    const amt = whole + frac;
    if (!Number.isFinite(amt)) return null;
    return amt * priceUsd;
  } catch {
    return null;
  }
}

/** Proportional sell size from trader fill vs size we attributed at entry. */
export function sellFraction(opts: {
  traderSellUsd: number | null;
  traderSizeAtEntryUsd: number | null;
}): number {
  const { traderSellUsd, traderSizeAtEntryUsd } = opts;
  if (traderSellUsd == null || traderSellUsd <= 0) return 1; // unknown → full exit
  if (traderSizeAtEntryUsd == null || traderSizeAtEntryUsd <= 0) return 1;
  return Math.min(1, traderSellUsd / traderSizeAtEntryUsd);
}

export function scaleRawAmount(raw: string, fraction: number): string {
  if (!(fraction > 0)) return "0";
  if (fraction >= 1) return raw;
  try {
    const r = BigInt(raw);
    const scaled = (r * BigInt(Math.floor(fraction * 1_000_000))) / 1_000_000n;
    return scaled > 0n ? scaled.toString() : "0";
  } catch {
    return "0";
  }
}

/** 0x native ETH sentinel (not WETH). */
export const ZEROX_NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
