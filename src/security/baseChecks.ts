/**
 * Base (EVM) pre-trade checks. Base stays off unless chains.base is true.
 * Holder concentration cannot be read from a Base RPC (no largest-accounts API
 * and no indexer key). That check fails closed while maxTopHolderBps > 0.
 */

export const BASE_WETH = "0x4200000000000000000000000000000000000006";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MINT_SELECTOR = "40c10f19";

export function wordAddress(data: string | null | undefined): string | null {
  if (!data) return null;
  const hex = data.toLowerCase().replace(/^0x/, "");
  if (hex.length < 64) return null;
  const addr = hex.slice(-40);
  if (!/^[0-9a-f]{40}$/.test(addr)) return null;
  return `0x${addr}`;
}

export function wordBool(data: string | null | undefined): boolean | null {
  const addr = wordAddress(data);
  if (!addr) return null;
  return addr !== `0x${"0".repeat(40)}`;
}

export function bytecodeHasMint(code: string | null | undefined): boolean {
  if (!code) return false;
  return code.toLowerCase().replace(/^0x/, "").includes(MINT_SELECTOR);
}

export function judgeBaseControls(opts: {
  owner: string | null;
  ownerCallFailed: boolean;
  paused: boolean | null;
  blacklisted: boolean | null;
  bytecode: string | null;
}): { blocked: boolean; detail: string } {
  if (opts.paused === true) return { blocked: true, detail: "base_paused: token is paused" };
  if (opts.blacklisted === true) return { blocked: true, detail: "base_blacklist: taker is blacklisted" };
  const ownerSet = opts.owner != null && opts.owner !== `0x${"0".repeat(40)}`;
  if (ownerSet && bytecodeHasMint(opts.bytecode)) {
    return { blocked: true, detail: "base_mintable: owner is set and bytecode contains mint(address,uint256)" };
  }
  if (ownerSet) return { blocked: true, detail: "base_owner: owner() is set" };
  if (opts.ownerCallFailed && opts.owner == null && opts.paused == null) {
    return { blocked: false, detail: "base_controls: owner/paused calls reverted (treated as absent)" };
  }
  return { blocked: false, detail: "base controls ok" };
}

export type BaseSellSim = "ok" | "no_balance" | "honeypot";

export function classifyBaseSellSim(opts: {
  reverted: boolean;
  revertText: string;
  tokenBalance: bigint;
}): BaseSellSim {
  if (!opts.reverted) return "ok";
  const text = opts.revertText.toLowerCase();
  if (
    opts.tokenBalance === 0n ||
    text.includes("insufficient") ||
    text.includes("exceeds balance") ||
    text.includes("transfer amount")
  ) {
    return "no_balance";
  }
  return "honeypot";
}

export function judgeBaseBalanceDiff(opts: {
  nativeBefore: bigint;
  nativeAfter: bigint;
  maxNativeDrop: bigint;
  /** Drops of ERC-20 balances. allowedDrop is the sell amount for the sold token, else 0. */
  tokens: Array<{ token: string; before: bigint; after: bigint; allowedDrop: bigint }>;
}): { ok: boolean; error?: string } {
  const nativeDrop = opts.nativeBefore - opts.nativeAfter;
  if (nativeDrop > opts.maxNativeDrop) {
    return { ok: false, error: `base_balance: native drop ${nativeDrop} > max ${opts.maxNativeDrop}` };
  }
  for (const t of opts.tokens) {
    const drop = t.before - t.after;
    if (drop > t.allowedDrop) {
      return { ok: false, error: `base_balance: ${t.token} drop ${drop} > allowed ${t.allowedDrop}` };
    }
  }
  return { ok: true };
}

/** Pull a native balance change out of a trace_call stateDiff, when the node returns one. */
export function nativeBalanceFromTrace(
  traced: unknown,
  address: string,
): { before: bigint; after: bigint } | null {
  if (!traced || typeof traced !== "object") return null;
  const diff = (traced as { stateDiff?: Record<string, { balance?: { "*": { from?: string; to?: string } } }> })
    .stateDiff;
  if (!diff) return null;
  const row = diff[address] ?? diff[address.toLowerCase()];
  const bal = row?.balance?.["*"];
  if (!bal?.from || !bal?.to) return null;
  try {
    return { before: BigInt(bal.from), after: BigInt(bal.to) };
  } catch {
    return null;
  }
}

export function baseHolderCheck(maxTopHolderBps: number): { blocked: boolean; detail: string } {
  if (!(maxTopHolderBps > 0)) return { blocked: false, detail: "base holder check off" };
  return {
    blocked: true,
    detail:
      "base_holders: Base RPC cannot list holders (no getTokenLargestAccounts, no indexer key). Fail closed while maxTopHolderBps > 0.",
  };
}

export function baseLiquidityUsd(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const pairs = (body as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) return null;
  let best = 0;
  let saw = false;
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") continue;
    const row = pair as {
      chainId?: string;
      quoteToken?: { address?: string };
      liquidity?: { usd?: unknown };
    };
    if ((row.chainId ?? "").toLowerCase() !== "base") continue;
    const quote = (row.quoteToken?.address ?? "").toLowerCase();
    if (quote !== BASE_WETH && quote !== BASE_USDC) continue;
    const usd = row.liquidity?.usd;
    if (typeof usd === "number" && Number.isFinite(usd)) {
      saw = true;
      if (usd > best) best = usd;
    }
  }
  return saw ? best : null;
}
