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

/** The default public Solana RPC. It rejects getTokenLargestAccounts with HTTP 429. */
export function isPublicSolanaRpc(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "api.mainnet-beta.solana.com";
  } catch {
    return false;
  }
}

export const PUBLIC_RPC_HOLDER_WARNING =
  "Top-holder check is ON but SOLANA_RPC_URL is the public mainnet endpoint (api.mainnet-beta.solana.com). That RPC returns HTTP 429 for getTokenLargestAccounts, and this check fails closed, so every buy will be blocked. Point SOLANA_RPC_URL at a paid RPC that serves getTokenLargestAccounts. The check is not disabled.";
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
    maxTransferFeeBps?: number;
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
    else {
      finding.warnings.push(`mint owner is not Token or Token-2022: ${owner ?? "missing"}`);
      if (mode === "block") {
        finding.blocked = true;
        finding.blockReason = "unknown_program";
      }
      return finding;
    }

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
      const parsedType = parsed.parsed?.type;
      if (parsedType !== "mint") {
        finding.warnings.push(`account is not a mint (type=${parsedType ?? "missing"})`);
        if (mode === "block") {
          finding.blocked = true;
          finding.blockReason = "not_a_mint";
        }
        return finding;
      }
      const info = parsed.parsed?.info;
      if (!info) {
        finding.warnings.push("mint account did not parse");
        if (mode === "block") {
          finding.blocked = true;
          finding.blockReason = "not_a_mint";
        }
        return finding;
      }
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
            const state = e.state as {
              newerTransferFee?: { transferFeeBasisPoints?: number };
              olderTransferFee?: { transferFeeBasisPoints?: number };
            } | undefined;
            const bps = Math.max(
              state?.newerTransferFee?.transferFeeBasisPoints ?? 0,
              state?.olderTransferFee?.transferFeeBasisPoints ?? 0,
            );
            const maxFee = opts.maxTransferFeeBps ?? 100;
            if (bps > maxFee) {
              finding.warnings.push(`transfer fee ${bps}bps > max ${maxFee}`);
              if (mode === "block") {
                finding.blocked = true;
                finding.blockReason = finding.blockReason ?? "transfer_fee";
              }
            }
          }
          if (name === "permanentdelegate" || name === "permanent_delegate") {
            finding.warnings.push("Token-2022 permanent delegate");
            if (mode === "block") {
              finding.blocked = true;
              finding.blockReason = finding.blockReason ?? "permanent_delegate";
            }
          }
          if (name === "nontransferable" || name === "non_transferable") {
            finding.warnings.push("Token-2022 non-transferable");
            if (mode === "block") {
              finding.blocked = true;
              finding.blockReason = finding.blockReason ?? "non_transferable";
            }
          }
          if (name === "defaultaccountstate" || name === "default_account_state") {
            const state = e.state as { state?: string } | string | undefined;
            const frozen =
              state === "frozen" ||
              (typeof state === "object" && state?.state?.toLowerCase() === "frozen");
            if (frozen) {
              finding.warnings.push("Token-2022 default account state is frozen");
              if (mode === "block") {
                finding.blocked = true;
                finding.blockReason = finding.blockReason ?? "default_frozen";
              }
            }
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
  if (bps >= opts.maxTopHolderBps) {
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
    const SOL = "So11111111111111111111111111111111111111112";
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    let best = 0;
    let saw = false;
    for (const pair of pairs) {
      if (!pair || typeof pair !== "object") continue;
      const row = pair as {
        chainId?: string;
        quoteToken?: { address?: string };
        liquidity?: { usd?: unknown };
      };
      if ((row.chainId ?? "").toLowerCase() !== "solana") continue;
      const quote = row.quoteToken?.address ?? "";
      if (quote !== SOL && quote !== USDC) continue;
      const usd = row.liquidity?.usd;
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
