/**
 * FOMO alert / REST payload adapter.
 *
 * All parsing of undocumented or loosely-typed FOMO fields lives HERE.
 * Where docs are clear we map documented fields; where unclear we TODO
 * and fall back safely (null / other) so the engine never invents data.
 *
 * Docs last reviewed against https://fomoapi.io/docs (Sept 23, 2026 review note).
 */
import type { AlertSide, ChainName, NormalizedAlert } from "../types.js";

const CHAIN_BY_ID: Record<number, ChainName> = {
  1399811149: "solana",
  101: "solana",
  8453: "base",
  4663: "robinhood",
  56: "bsc",
  1: "ethereum",
  5042: "arc",
  143: "monad",
};

const CHAIN_BY_NAME: Record<string, ChainName> = {
  solana: "solana",
  sol: "solana",
  base: "base",
  robinhood: "robinhood",
  hood: "robinhood",
  rh: "robinhood",
  bsc: "bsc",
  bnb: "bsc",
  eth: "ethereum",
  ethereum: "ethereum",
  arc: "arc",
  monad: "monad",
  hyperliquid: "hyperliquid",
};

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

export function resolveChain(raw: Record<string, unknown>): {
  chain: ChainName;
  chainId: number | null;
} {
  const chainId = asNumber(raw.chainId);
  const chainName = asString(raw.chain)?.toLowerCase() ?? null;
  if (chainName && CHAIN_BY_NAME[chainName]) {
    return { chain: CHAIN_BY_NAME[chainName], chainId };
  }
  if (chainId !== null && CHAIN_BY_ID[chainId]) {
    return { chain: CHAIN_BY_ID[chainId], chainId };
  }
  // TODO: FOMO may emit other network ids; extend CHAIN_BY_ID when observed.
  return { chain: "unknown", chainId };
}

export function mapAlertType(raw: unknown): AlertSide {
  const t = asString(raw)?.toLowerCase() ?? "";
  if (t === "buy" || t === "sell" || t === "thesis" || t === "transfer") return t;
  // Docs also list: perp | listing | milestone | whale | price | trade | follow
  if (t.includes("buy")) return "buy";
  if (t.includes("sell")) return "sell";
  if (t === "thesis") return "thesis";
  if (t === "transfer") return "transfer";
  return "other";
}

/**
 * Parse a single WS/REST alert object into NormalizedAlert.
 * Expected documented fields (from /ws/alerts example):
 *   type, alertType, source, eventId, userId, tradeId, swapId, transferId,
 *   trader, token, tokenAddress, chainId, chain, usdValue, positionValueUsd,
 *   text, ts — plus optional tradeUsd, txHash, execTs when fill-matched.
 */
export function parseAlert(rawUnknown: unknown): NormalizedAlert | null {
  if (!rawUnknown || typeof rawUnknown !== "object") return null;
  const raw = rawUnknown as Record<string, unknown>;

  // Welcome / subscribed / heartbeat — not alerts
  const type = asString(raw.type);
  if (type && type !== "alert") {
    // REST /v2/alerts items may omit type:"alert"; continue if alertType present
    if (!raw.alertType && !raw.side) return null;
  }

  const { chain, chainId } = resolveChain(raw);
  const alertType = mapAlertType(raw.alertType ?? raw.side ?? raw.type);

  // Dedupe key: docs say eventId is stable; synthesize fallback if missing.
  // NEVER use Date.now() here — non-deterministic ids defeat claimEventStrict and allow double buys
  // when the same alert is parsed twice without an eventId.
  const tokenAddrForId =
    asString(raw.tokenAddress) ??
    (raw.token && typeof raw.token === "object"
      ? asString((raw.token as Record<string, unknown>).address)
      : null);
  const eventId =
    asString(raw.eventId) ??
    asString(raw.id) ??
    [
      "synth",
      asString(raw.tradeId) ?? asString(raw.swapId) ?? asString(raw.txHash) ?? "x",
      asString(raw.ts) ?? asString(raw.execTs) ?? "nots",
      asString(raw.trader) ?? asString(raw.userId) ?? "",
      tokenAddrForId ?? "",
      mapAlertType(raw.alertType ?? raw.side ?? raw.type),
    ].join(":");

  // Fill size: docs — use tradeUsd when present; do NOT substitute usdValue
  const tradeUsd = asNumber(raw.tradeUsd);
  const usdValue = asNumber(raw.usdValue);
  const positionValueUsd = asNumber(raw.positionValueUsd);

  // Market cap: documented on /ws/trades token.mcap, NOT clearly on /ws/alerts.
  // TODO: if alerts ever include mcap / marketCapUsd, map it here.
  let marketCapUsd: number | null = null;
  const tokenObj = raw.token;
  if (tokenObj && typeof tokenObj === "object") {
    const t = tokenObj as Record<string, unknown>;
    marketCapUsd = asNumber(t.mcap) ?? asNumber(t.marketCapUsd) ?? asNumber(t.marketCap);
  }
  marketCapUsd =
    marketCapUsd ?? asNumber(raw.marketCapUsd) ?? asNumber(raw.mcap) ?? null;

  const tokenSymbol =
    asString(raw.token) ??
    (tokenObj && typeof tokenObj === "object"
      ? asString((tokenObj as Record<string, unknown>).symbol)
      : null);

  const tokenAddress =
    asString(raw.tokenAddress) ??
    (tokenObj && typeof tokenObj === "object"
      ? asString((tokenObj as Record<string, unknown>).address)
      : null);

  return {
    eventId,
    alertType,
    source: asString(raw.source) ?? "feed",
    userId: asString(raw.userId),
    tradeId: asString(raw.tradeId),
    swapId: asString(raw.swapId),
    traderHandle: asString(raw.trader),
    tokenSymbol,
    tokenAddress,
    chain,
    chainId,
    tradeUsd,
    usdValue,
    positionValueUsd,
    text: asString(raw.text),
    ts: asNumber(raw.ts) ?? asNumber(raw.execTs),
    txHash: asString(raw.txHash),
    marketCapUsd,
    raw: rawUnknown,
  };
}

/** Parse REST GET /v2/alerts response body into alerts[]. */
export function parseAlertsRestBody(body: unknown): NormalizedAlert[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  // TODO: confirm exact envelope — docs say newest-first items; field name may be
  // `alerts` or `items` or a bare array. Probe both.
  const list = Array.isArray(b.alerts)
    ? b.alerts
    : Array.isArray(b.items)
      ? b.items
      : Array.isArray(b.data)
        ? b.data
        : Array.isArray(body)
          ? body
          : [];
  const out: NormalizedAlert[] = [];
  for (const item of list) {
    const n = parseAlert(item);
    if (n) out.push(n);
  }
  return out;
}

export function parseWelcome(msg: unknown): { realtime?: boolean; delaySeconds?: number } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (asString(m.type) !== "welcome") return null;
  return {
    realtime: typeof m.realtime === "boolean" ? m.realtime : undefined,
    delaySeconds: asNumber(m.delaySeconds) ?? undefined,
  };
}
