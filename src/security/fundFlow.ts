/**
 * Top-level SOL and token movements must pay our wallet or one of our ATAs.
 * AMM pool vaults are reached only by CPI inside an allowlisted program, so a
 * top-level transfer to a stranger is rejected. setAuthority is always rejected.
 */
import { PublicKey } from "@solana/web3.js";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const TOKEN_PROGRAMS = new Set([TOKEN, TOKEN_2022]);

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA,
  )[0];
}

export function allowedFundAccounts(owner: PublicKey, mints: string[], platformFeeAccount?: string | null): Set<string> {
  const allow = new Set<string>([owner.toBase58()]);
  if (platformFeeAccount) allow.add(platformFeeAccount);
  const programs = [new PublicKey(TOKEN), new PublicKey(TOKEN_2022)];
  for (const mint of [WSOL_MINT, ...mints]) {
    let mintKey: PublicKey;
    try {
      mintKey = new PublicKey(mint);
    } catch {
      continue;
    }
    for (const program of programs) {
      allow.add(associatedTokenAddress(owner, mintKey, program).toBase58());
    }
  }
  return allow;
}

function systemDiscriminator(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  return data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24);
}

export interface FundIx {
  program: string;
  data: Uint8Array;
  accounts: PublicKey[];
}

/**
 * Reject top-level System transfers, token transfers, transferChecked, and
 * closeAccount whose destination is not our wallet or our ATA. setAuthority
 * is always rejected.
 */
export function checkTopLevelFundFlow(opts: {
  instructions: FundIx[];
  owner: PublicKey;
  mints: string[];
  platformFeeAccount?: string | null;
}): { ok: true } | { ok: false; error: string } {
  const allowed = allowedFundAccounts(opts.owner, opts.mints, opts.platformFeeAccount);
  for (const ix of opts.instructions) {
    if (ix.program === SYSTEM) {
      if (systemDiscriminator(ix.data) !== 2) continue;
      const dest = ix.accounts[1];
      if (!dest || !allowed.has(dest.toBase58())) {
        return { ok: false, error: "tx: system transfer destination is not our wallet or ATA" };
      }
    }
    if (!TOKEN_PROGRAMS.has(ix.program)) continue;
    const disc = ix.data[0];
    if (disc == null) return { ok: false, error: "tx: token instruction missing discriminator" };
    if (disc === 6) return { ok: false, error: "tx: setAuthority is not allowed" };
    if (disc === 3) {
      const dest = ix.accounts[1];
      if (!dest || !allowed.has(dest.toBase58())) {
        return { ok: false, error: "tx: token transfer destination is not our wallet or ATA" };
      }
    }
    if (disc === 12) {
      const dest = ix.accounts[2];
      if (!dest || !allowed.has(dest.toBase58())) {
        return { ok: false, error: "tx: token transferChecked destination is not our wallet or ATA" };
      }
    }
    if (disc === 9) {
      const dest = ix.accounts[1];
      if (!dest || !allowed.has(dest.toBase58())) {
        return { ok: false, error: "tx: closeAccount destination is not our wallet or ATA" };
      }
    }
  }
  return { ok: true };
}
