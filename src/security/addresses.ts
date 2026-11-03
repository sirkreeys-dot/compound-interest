import bs58 from "bs58";

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
/** Solana pubkeys are 32-byte base58; typical length 32–44. */
const SOLANA_B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidEvmAddress(addr: string): boolean {
  return typeof addr === "string" && EVM_RE.test(addr.trim());
}

export function isValidSolanaAddress(addr: string): boolean {
  if (typeof addr !== "string") return false;
  const a = addr.trim();
  if (!SOLANA_B58_RE.test(a)) return false;
  try {
    const bytes = bs58.decode(a);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/** Validate token mint/address for a chain we execute on. */
export function isValidTokenAddress(
  chain: string,
  addr: string | null | undefined,
): boolean {
  if (!addr) return false;
  if (chain === "solana") return isValidSolanaAddress(addr);
  if (chain === "base" || chain === "ethereum" || chain === "bsc") {
    return isValidEvmAddress(addr);
  }
  // Unsupported execution chains — still require non-empty sane string
  return addr.trim().length >= 4 && addr.trim().length <= 128;
}
