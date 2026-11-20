/**
 * Solana token safety: freeze authority + Token-2022 transfer hooks / transfer fees.
 * Uses getParsedAccountInfo — FOMO alerts alone are never enough to trust a mint.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../utils/logger.js";

export type TokenSafetyMode = "block" | "warn" | "off";

export interface TokenSafetyFinding {
  mint: string;
  program: "spl-token" | "token-2022" | "unknown";
  freezeAuthority: string | null;
  mintAuthority: string | null;
  hasTransferHook: boolean;
  hasTransferFee: boolean;
  /** Raw supply string when the parsed mint included it. */
  supply: string | null;
  warnings: string[];
  /** True when mode=block and a hard-block condition matched. */
  blocked: boolean;
  blockReason?: string;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export async function inspectSolanaMint(
  rpcUrl: string,
  mint: string,
  opts: {
    mode?: TokenSafetyMode;
    blockFreezeAuthority?: boolean;
    blockTransferHooks?: boolean;
    /** Active mint authority. Default true (fail closed on a live mint). */
    blockMintAuthority?: boolean;
    /** Transfer-fee mints: block | warn (default warn). */
    transferFeePolicy?: "block" | "warn" | "off";
    fetchImpl?: typeof fetch;
    /** Injected parsed-account lookup for tests. */
    getParsedAccountInfo?: (
      mint: string,
    ) => Promise<{ owner: string; parsed: unknown } | null>;
  } = {},
): Promise<TokenSafetyFinding> {
  const mode = opts.mode ?? "block";
  const blockFreeze = opts.blockFreezeAuthority ?? true;
  const blockHooks = opts.blockTransferHooks ?? true;
  const blockMint = opts.blockMintAuthority ?? true;
  const feePolicy = opts.transferFeePolicy ?? "warn";

  const finding: TokenSafetyFinding = {
    mint,
    program: "unknown",
    freezeAuthority: null,
    mintAuthority: null,
    hasTransferHook: false,
    hasTransferFee: false,
    supply: null,
    warnings: [],
    blocked: false,
  };

  if (mode === "off") return finding;

  try {
    const conn = new Connection(rpcUrl, "confirmed");
    const pk = new PublicKey(mint);
    const injected = opts.getParsedAccountInfo
      ? await opts.getParsedAccountInfo(mint)
      : null;
    const acc = opts.getParsedAccountInfo
      ? null
      : await conn.getParsedAccountInfo(pk, "confirmed");
    const owner = injected
      ? injected.owner
      : acc?.value
        ? acc.value.owner.toBase58()
        : null;
    const parsedData = injected ? injected.parsed : acc?.value?.data;
    if (!injected && !acc?.value) {
      finding.warnings.push("mint account not found on RPC");
      finding.blocked = mode === "block";
      finding.blockReason = "mint_not_found";
      return finding;
    }
    if (owner === TOKEN_PROGRAM) finding.program = "spl-token";
    else if (owner === TOKEN_2022_PROGRAM) finding.program = "token-2022";

    const data = parsedData;
    if (data && typeof data === "object" && data !== null && "parsed" in data) {
      const parsed = data as {
        parsed?: {
          type?: string;
          info?: {
            freezeAuthority?: string | null;
            mintAuthority?: string | null;
            supply?: string | number | null;
            extensions?: Array<{ extension?: string; state?: unknown }>;
          };
        };
      };
      const info = parsed.parsed?.info;
      if (info) {
        finding.freezeAuthority = info.freezeAuthority ?? null;
        finding.mintAuthority = info.mintAuthority ?? null;
        if (info.supply != null) finding.supply = String(info.supply);
        const exts = info.extensions ?? [];
        for (const e of exts) {
          const name = (e.extension ?? "").toLowerCase();
          if (name === "transferhook" || name === "transfer_hook") {
            finding.hasTransferHook = true;
          }
          if (name === "transferfeeconfig" || name === "transfer_fee_config") {
            finding.hasTransferFee = true;
          }
        }
      }
    }

    if (finding.freezeAuthority && blockFreeze) {
      const msg = `freeze authority set: ${finding.freezeAuthority}`;
      finding.warnings.push(msg);
      if (mode === "block") {
        finding.blocked = true;
        finding.blockReason = "freeze_authority";
      }
    }
    if (finding.hasTransferHook && blockHooks) {
      finding.warnings.push("Token-2022 transfer hook present");
      if (mode === "block") {
        finding.blocked = true;
        finding.blockReason = finding.blockReason ?? "transfer_hook";
      }
    }
    if (finding.mintAuthority && blockMint) {
      const msg = `mint authority set: ${finding.mintAuthority}`;
      finding.warnings.push(msg);
      if (mode === "block") {
        finding.blocked = true;
        finding.blockReason = finding.blockReason ?? "mint_authority";
      }
    }
    if (finding.hasTransferFee) {
      finding.warnings.push("Token-2022 transfer fee config present");
      if (feePolicy === "block" && mode === "block") {
        finding.blocked = true;
        finding.blockReason = finding.blockReason ?? "transfer_fee";
      }
    }
  } catch (e) {
    log.warn(
      `tokenSafety inspect failed for ${mint}: ${e instanceof Error ? e.message : String(e)}`,
    );
    finding.warnings.push("token safety RPC inspect failed");
    // Fail closed on buys when mode=block — cannot verify
    if (mode === "block") {
      finding.blocked = true;
      finding.blockReason = "inspect_failed";
    }
  }

  return finding;
}

/** Share of supply held by the largest token account, in bps. Null when supply is unusable. */
export function holderConcentrationBps(topAmount: bigint, supply: bigint): number | null {
  if (supply <= 0n || topAmount < 0n) return null;
  return Number((topAmount * 10_000n) / supply);
}

/**
 * Top-holder check. Enabled only when maxTopHolderBps > 0.
 * Missing data or a failed lookup blocks (fail closed) while the check is enabled.
 */
export function evaluateTopHolder(opts: {
  maxTopHolderBps: number;
  topAmount: bigint | null;
  supply: bigint | null;
  fetchFailed: boolean;
}): { blocked: boolean; detail: string } {
  if (!(opts.maxTopHolderBps > 0)) return { blocked: false, detail: "top holder check off" };
  if (opts.fetchFailed || opts.topAmount == null || opts.supply == null) {
    return { blocked: true, detail: "top holder lookup failed (fail closed)" };
  }
  const bps = holderConcentrationBps(opts.topAmount, opts.supply);
  if (bps == null) return { blocked: true, detail: "top holder supply unusable (fail closed)" };
  if (bps > opts.maxTopHolderBps) {
    return {
      blocked: true,
      detail: `top holder ${bps}bps > maxTopHolderBps ${opts.maxTopHolderBps}`,
    };
  }
  return { blocked: false, detail: `top holder ${bps}bps` };
}

/**
 * Optional liquidity floor. When minLiquidityUsd is 0 the check is off.
 * When it is on, a failed lookup or a missing figure blocks (fail closed).
 */
export function evaluateLiquidity(opts: {
  minLiquidityUsd: number;
  liquidityUsd: number | null;
  fetchFailed: boolean;
}): { blocked: boolean; detail: string } {
  if (!(opts.minLiquidityUsd > 0)) return { blocked: false, detail: "liquidity check off" };
  if (opts.fetchFailed || opts.liquidityUsd == null || !Number.isFinite(opts.liquidityUsd)) {
    return { blocked: true, detail: "liquidity lookup failed (fail closed)" };
  }
  if (opts.liquidityUsd < opts.minLiquidityUsd) {
    return {
      blocked: true,
      detail: `liquidity $${opts.liquidityUsd} < min $${opts.minLiquidityUsd}`,
    };
  }
  return { blocked: false, detail: `liquidity $${opts.liquidityUsd}` };
}

/**
 * One JSON-RPC getTokenLargestAccounts call. No client-side 429 retry:
 * a rate limit is a failed lookup and the caller fails closed.
 */
export async function fetchLargestHolderAmount(
  rpcUrl: string,
  mint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ amount: bigint | null; failed: boolean }> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [mint],
      }),
    });
    if (!res.ok) return { amount: null, failed: true };
    const body = (await res.json()) as {
      error?: { message?: string };
      result?: { value?: Array<{ amount?: string }> };
    };
    if (body.error) return { amount: null, failed: true };
    const raw = body.result?.value?.[0]?.amount;
    if (raw == null || !/^\d+$/.test(raw)) return { amount: null, failed: true };
    return { amount: BigInt(raw), failed: false };
  } catch {
    return { amount: null, failed: true };
  }
}

/** Best-effort USD liquidity from a DexScreener token response. Null if the body is unusable. */
export function liquidityUsdFromDexScreener(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const pairs = (body as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) return null;
  let best = 0;
  let saw = false;
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") continue;
    const usd = (pair as { liquidity?: { usd?: unknown } }).liquidity?.usd;
    if (typeof usd === "number" && Number.isFinite(usd)) {
      saw = true;
      if (usd > best) best = usd;
    }
  }
  return saw ? best : null;
}

export async function fetchDexScreenerLiquidity(
  mint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ liquidityUsd: number | null; fetchFailed: boolean }> {
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
    if (!res.ok) return { liquidityUsd: null, fetchFailed: true };
    const body = (await res.json()) as unknown;
    const liquidityUsd = liquidityUsdFromDexScreener(body);
    if (liquidityUsd == null) return { liquidityUsd: null, fetchFailed: true };
    return { liquidityUsd, fetchFailed: false };
  } catch {
    return { liquidityUsd: null, fetchFailed: true };
  }
}
