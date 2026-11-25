/**
 * Fake-liquidity checks that sit beside the $10k SOL/USDC floor.
 * They do not change that floor, the 90% holder cap, or the 25% round-trip cap.
 */

export interface SolPairSnapshot {
  liquidityUsd: number;
  pairCreatedAtMs: number | null;
  /** Quote-side reserve (SOL or USDC atoms / tokens as DexScreener reports it). Null if absent. */
  quoteReserve: number | null;
}

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function bestSolanaPair(body: unknown): SolPairSnapshot | null {
  if (!body || typeof body !== "object") return null;
  const pairs = (body as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) return null;
  let best: SolPairSnapshot | null = null;
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") continue;
    const row = pair as {
      chainId?: string;
      pairCreatedAt?: unknown;
      quoteToken?: { address?: string };
      liquidity?: { usd?: unknown; quote?: unknown };
    };
    if ((row.chainId ?? "").toLowerCase() !== "solana") continue;
    const quote = row.quoteToken?.address ?? "";
    if (quote !== SOL && quote !== USDC) continue;
    const usd = row.liquidity?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) continue;
    const created =
      typeof row.pairCreatedAt === "number" && Number.isFinite(row.pairCreatedAt)
        ? row.pairCreatedAt
        : null;
    const reserve =
      typeof row.liquidity?.quote === "number" && Number.isFinite(row.liquidity.quote)
        ? row.liquidity.quote
        : null;
    if (!best || usd > best.liquidityUsd) {
      best = { liquidityUsd: usd, pairCreatedAtMs: created, quoteReserve: reserve };
    }
  }
  return best;
}

export function evaluateFakeLiquidity(opts: {
  minLiquidityUsd: number;
  minPairAgeSec: number;
  nowMs: number;
  pair: SolPairSnapshot | null;
  fetchFailed: boolean;
}): { blocked: boolean; detail: string } {
  if (!(opts.minLiquidityUsd > 0)) return { blocked: false, detail: "fake-liquidity checks off" };
  if (opts.fetchFailed || !opts.pair) {
    return { blocked: true, detail: "fake_liquidity: pair lookup failed (fail closed)" };
  }
  if (opts.minPairAgeSec > 0) {
    if (opts.pair.pairCreatedAtMs == null) {
      return { blocked: true, detail: "fake_liquidity: pair age missing (fail closed)" };
    }
    const ageSec = (opts.nowMs - opts.pair.pairCreatedAtMs) / 1000;
    if (ageSec < opts.minPairAgeSec) {
      return {
        blocked: true,
        detail: `fake_liquidity: pair is ${Math.max(0, Math.round(ageSec))}s old < minPairAgeSec ${opts.minPairAgeSec}`,
      };
    }
  }
  if (opts.pair.quoteReserve === 0) {
    return { blocked: true, detail: "fake_liquidity: SOL/USDC reserve is zero (one-sided pool)" };
  }
  return { blocked: false, detail: "pair age and quote reserve ok" };
}

/**
 * DexScreener says the pool is deep, but selling our size moves the price too far.
 * The 25% round-trip cap still applies on its own. This is the disagreement check.
 */
export function evaluateQuoteDepth(opts: {
  minLiquidityUsd: number;
  liquidityUsd: number | null;
  maxImpactBps: number;
  sellImpactBps: number | null;
}): { blocked: boolean; detail: string } {
  if (!(opts.minLiquidityUsd > 0) || !(opts.maxImpactBps > 0)) {
    return { blocked: false, detail: "quote-depth check off" };
  }
  if (opts.sellImpactBps == null) {
    return { blocked: false, detail: "sell impact not on the quote; simulation decides the sell" };
  }
  if (opts.liquidityUsd == null) {
    return { blocked: true, detail: "fake_liquidity: liquidity missing while checking sell impact (fail closed)" };
  }
  if (opts.liquidityUsd >= opts.minLiquidityUsd && opts.sellImpactBps > opts.maxImpactBps) {
    return {
      blocked: true,
      detail: `fake_liquidity: sell impact ${opts.sellImpactBps}bps > ${opts.maxImpactBps}bps while DexScreener liquidity is $${opts.liquidityUsd}`,
    };
  }
  return { blocked: false, detail: `sell impact ${opts.sellImpactBps}bps` };
}

/** Jupiter priceImpactPct is a fraction (0.10 = 10%). Values above 1 are treated as percent. */
export function jupiterImpactBps(priceImpactPct: number | string | null | undefined): number | null {
  if (priceImpactPct == null) return null;
  const n = typeof priceImpactPct === "number" ? priceImpactPct : Number(priceImpactPct);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return Math.round(n * 10_000);
  return Math.round(n * 100);
}
