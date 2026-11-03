/**
 * Fresh USD prices for native assets.
 * Primary: Jupiter Price API v3 (Solana) / 0x allowance-holder price (Base).
 * CoinGecko only as short-TTL fallback with sanity bounds — refuse if stale/missing.
 *
 * Jupiter: GET https://api.jup.ag/price/v3?ids=<mint> → { [mint]: { usdPrice, blockId, decimals } }
 * 0x: GET https://api.0x.org/swap/allowance-holder/price?chainId=8453&sellToken=0xEeee…&buyToken=USDC&sellAmount=1e18
 */
import { log } from "./logger.js";
import { ZEROX_NATIVE_ETH } from "./money.js";

export type PriceSource = "jupiter_v3" | "jupiter_order" | "zerox_price" | "coingecko_fallback";

export interface FreshPrice {
  usd: number;
  source: PriceSource;
  fetchedAtMs: number;
  /** Jupiter blockId when from price v3 */
  blockId?: number;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const SOL_SANITY = { min: 5, max: 10_000 };
const ETH_SANITY = { min: 100, max: 50_000 };

export interface PriceServiceOpts {
  jupiterApiKey?: string;
  zeroXApiKey?: string;
  /** Max age for a cached primary price (ms). Default 30s. */
  maxAgeMs?: number;
  /** Max age for CoinGecko fallback (ms). Default 15s — tighter. */
  coingeckoMaxAgeMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export class PriceService {
  private cache = new Map<string, FreshPrice>();
  private readonly maxAgeMs: number;
  private readonly cgMaxAgeMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly jupiterApiKey: string;
  private readonly zeroXApiKey: string;

  constructor(opts: PriceServiceOpts = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 30_000;
    this.cgMaxAgeMs = opts.coingeckoMaxAgeMs ?? 15_000;
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.jupiterApiKey = opts.jupiterApiKey ?? "";
    this.zeroXApiKey = opts.zeroXApiKey ?? "";
  }

  /** SOL USD — Jupiter Price v3, then /order USDC→SOL cross-check, then guarded CoinGecko. */
  async getSolUsd(): Promise<FreshPrice> {
    const cached = this.getFreshCached("sol", this.maxAgeMs);
    if (cached && cached.source !== "coingecko_fallback") return cached;

    try {
      const p = await this.fetchJupiterPriceV3(SOL_MINT);
      if (p && inBounds(p.usd, SOL_SANITY)) {
        const fresh = { ...p, source: "jupiter_v3" as const };
        this.cache.set("sol", fresh);
        return fresh;
      }
    } catch (e) {
      log.debug("Jupiter price v3 SOL failed", e);
    }

    try {
      const p = await this.fetchSolViaJupiterOrder();
      if (p && inBounds(p.usd, SOL_SANITY)) {
        this.cache.set("sol", p);
        return p;
      }
    } catch (e) {
      log.debug("Jupiter order SOL price failed", e);
    }

    const cg = await this.fetchCoinGecko("solana", "sol", SOL_SANITY);
    if (cg) return cg;
    throw new Error("No fresh SOL/USD price (Jupiter + CoinGecko failed or out of bounds)");
  }

  /** ETH USD on Base — 0x price (1 ETH → USDC), then guarded CoinGecko. */
  async getEthUsd(): Promise<FreshPrice> {
    const cached = this.getFreshCached("eth", this.maxAgeMs);
    if (cached && cached.source !== "coingecko_fallback") return cached;

    try {
      const p = await this.fetchEthVia0x();
      if (p && inBounds(p.usd, ETH_SANITY)) {
        this.cache.set("eth", p);
        return p;
      }
    } catch (e) {
      log.debug("0x ETH price failed", e);
    }

    const cg = await this.fetchCoinGecko("ethereum", "eth", ETH_SANITY);
    if (cg) return cg;
    throw new Error("No fresh ETH/USD price (0x + CoinGecko failed or out of bounds)");
  }

  async getNativeUsd(chain: "solana" | "base"): Promise<FreshPrice> {
    return chain === "solana" ? this.getSolUsd() : this.getEthUsd();
  }

  /**
   * Convert raw output of a sell-into-native/stable quote into USD using a fresh price.
   * buyToken: SOL mint, USDC mint, 0xEeee, or Base USDC/WETH.
   */
  async rawOutToUsd(opts: {
    chain: "solana" | "base";
    buyToken: string;
    outAmountRaw: string;
    /** Prefer Jupiter order outUsdValue when present */
    quoteOutUsdValue?: number | null;
  }): Promise<{ usd: number; source: string } | null> {
    if (opts.quoteOutUsdValue != null && opts.quoteOutUsdValue > 0) {
      return { usd: opts.quoteOutUsdValue, source: "quote_outUsdValue" };
    }
    const token = opts.buyToken;
    try {
      if (opts.chain === "solana") {
        if (token === SOL_MINT) {
          const p = await this.getSolUsd();
          const usd = rawToUsdLocal(opts.outAmountRaw, 9, p.usd);
          return usd == null ? null : { usd, source: `raw*${p.source}` };
        }
        if (token === USDC_SOL) {
          const usd = rawToUsdLocal(opts.outAmountRaw, 6, 1);
          return usd == null ? null : { usd, source: "usdc_1_1" };
        }
      } else {
        if (token.toLowerCase() === ZEROX_NATIVE_ETH.toLowerCase()) {
          const p = await this.getEthUsd();
          const usd = rawToUsdLocal(opts.outAmountRaw, 18, p.usd);
          return usd == null ? null : { usd, source: `raw*${p.source}` };
        }
        if (token.toLowerCase() === USDC_BASE.toLowerCase()) {
          const usd = rawToUsdLocal(opts.outAmountRaw, 6, 1);
          return usd == null ? null : { usd, source: "usdc_1_1" };
        }
      }
    } catch (e) {
      log.debug("rawOutToUsd failed", e);
    }
    return null;
  }

  private getFreshCached(key: string, maxAge: number): FreshPrice | null {
    const c = this.cache.get(key);
    if (!c) return null;
    if (this.now() - c.fetchedAtMs > maxAge) return null;
    return c;
  }

  private async fetchJupiterPriceV3(mint: string): Promise<FreshPrice | null> {
    const headers: Record<string, string> = {};
    if (this.jupiterApiKey) headers["x-api-key"] = this.jupiterApiKey;
    const res = await this.fetchImpl(`https://api.jup.ag/price/v3?ids=${mint}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<
      string,
      { usdPrice?: number; blockId?: number; decimals?: number }
    >;
    const row = body[mint];
    if (!row || !(row.usdPrice! > 0)) return null;
    return {
      usd: row.usdPrice!,
      source: "jupiter_v3",
      fetchedAtMs: this.now(),
      blockId: row.blockId,
    };
  }

  /** Derive SOL/USD from swap/v2/order: 1 SOL → USDC outAmount/1e6, or use outUsdValue. */
  private async fetchSolViaJupiterOrder(): Promise<FreshPrice | null> {
    const headers: Record<string, string> = {};
    if (this.jupiterApiKey) headers["x-api-key"] = this.jupiterApiKey;
    const params = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: USDC_SOL,
      amount: "1000000000", // 1 SOL
    });
    const res = await this.fetchImpl(`https://api.jup.ag/swap/v2/order?${params}`, { headers });
    if (!res.ok) return null;
    const order = (await res.json()) as {
      outAmount?: string;
      outUsdValue?: number;
      inUsdValue?: number;
    };
    if (order.outUsdValue != null && order.outUsdValue > 0) {
      return {
        usd: order.outUsdValue,
        source: "jupiter_order",
        fetchedAtMs: this.now(),
      };
    }
    if (order.inUsdValue != null && order.inUsdValue > 0) {
      return { usd: order.inUsdValue, source: "jupiter_order", fetchedAtMs: this.now() };
    }
    if (order.outAmount) {
      const usd = Number(order.outAmount) / 1e6;
      if (usd > 0) return { usd, source: "jupiter_order", fetchedAtMs: this.now() };
    }
    return null;
  }

  /** 1 ETH → USDC on Base via 0x price. */
  private async fetchEthVia0x(): Promise<FreshPrice | null> {
    if (!this.zeroXApiKey) return null;
    const params = new URLSearchParams({
      chainId: "8453",
      sellToken: ZEROX_NATIVE_ETH,
      buyToken: USDC_BASE,
      sellAmount: "1000000000000000000", // 1 ETH
    });
    const res = await this.fetchImpl(
      `https://api.0x.org/swap/allowance-holder/price?${params}`,
      {
        headers: {
          "0x-api-key": this.zeroXApiKey,
          "0x-version": "v2",
        },
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { buyAmount?: string };
    if (!body.buyAmount) return null;
    const usd = Number(body.buyAmount) / 1e6;
    if (!(usd > 0)) return null;
    return { usd, source: "zerox_price", fetchedAtMs: this.now() };
  }

  private async fetchCoinGecko(
    id: "solana" | "ethereum",
    cacheKey: string,
    bounds: { min: number; max: number },
  ): Promise<FreshPrice | null> {
    const cached = this.getFreshCached(cacheKey, this.cgMaxAgeMs);
    if (cached && cached.source === "coingecko_fallback") return cached;

    const res = await this.fetchImpl(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, { usd?: number }>;
    const usd = j[id]?.usd;
    if (usd == null || !inBounds(usd, bounds)) {
      log.warn(`CoinGecko ${id} price missing or outside sanity bounds: ${usd}`);
      return null;
    }
    const fresh: FreshPrice = {
      usd,
      source: "coingecko_fallback",
      fetchedAtMs: this.now(),
    };
    this.cache.set(cacheKey, fresh);
    log.warn(`Using CoinGecko fallback for ${id}=$${usd} (maxAge ${this.cgMaxAgeMs}ms)`);
    return fresh;
  }
}

function inBounds(usd: number, b: { min: number; max: number }): boolean {
  return Number.isFinite(usd) && usd >= b.min && usd <= b.max;
}

function rawToUsdLocal(raw: string, decimals: number, priceUsd: number): number | null {
  try {
    const r = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const amt = Number(r) / Number(base);
    if (!Number.isFinite(amt)) return null;
    return amt * priceUsd;
  } catch {
    return null;
  }
}

export { SOL_MINT, USDC_SOL, USDC_BASE };
