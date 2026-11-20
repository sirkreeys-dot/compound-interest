/**
 * Top-level program allowlist for a Jupiter transaction we are about to sign.
 *
 * Chosen from a public GET /order (no signature) on 2026-11-20:
 * - SOL → BONK, router "metis", route label Whirlpool, two address-lookup tables.
 *   After the tables were resolved, the top-level programs were Compute Budget,
 *   System, SPL Token (SyncNative disc 17, CloseAccount disc 9), and Jupiter v6
 *   (JUP6…). Whirlpool itself was a CPI inside Jupiter, not a top-level program.
 * - SOL → USDC sometimes returns router "jupiterz", whose fee payer is not the
 *   user and which requires a second signer. Those orders are rejected by the
 *   sole-signer rule below. The JupiterZ program id is intentionally not listed.
 *
 * DEX program ids are included so a route that calls them directly still passes.
 * Anything else fails closed.
 */
import {
  PublicKey,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

export const DEFAULT_SOLANA_PROGRAM_ALLOWLIST: string[] = [
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
];

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

/** SPL / Token-2022 discriminators that grant or change authority. */
export const FORBIDDEN_TOKEN_DISCRIMINATORS = new Set<number>([
  4, // Approve
  6, // SetAuthority
  10, // FreezeAccount
  11, // ThawAccount
  13, // ApproveChecked
]);

export interface InspectTxOk {
  ok: true;
  accountKeys: PublicKey[];
}
export interface InspectTxErr {
  ok: false;
  error: string;
}

/**
 * Decode every top-level instruction. Fail closed if a lookup table was not
 * resolved, a program is off the allowlist, a token instruction grants a
 * delegate or changes authority, or any signer other than our wallet is required.
 */
export function inspectSwapInstructions(opts: {
  tx: VersionedTransaction;
  accountKeys: PublicKey[];
  ourPubkey: PublicKey;
  allowlist: string[];
}): InspectTxOk | InspectTxErr {
  const allow = new Set(opts.allowlist.map((s) => s.trim()).filter(Boolean));
  if (!allow.size) return { ok: false, error: "tx: program allowlist is empty (fail closed)" };

  const header = opts.tx.message.header;
  if (header.numRequiredSignatures !== 1) {
    return {
      ok: false,
      error: `tx: ${header.numRequiredSignatures} required signers — only our wallet may be required`,
    };
  }
  const feePayer = opts.accountKeys[0];
  if (!feePayer || !feePayer.equals(opts.ourPubkey)) {
    return { ok: false, error: "tx: fee payer is not our wallet" };
  }

  const lookups = opts.tx.message.addressTableLookups ?? [];
  if (lookups.length && opts.accountKeys.length <= opts.tx.message.staticAccountKeys.length) {
    return { ok: false, error: "tx: address lookup tables were not resolved (fail closed)" };
  }

  for (const ix of opts.tx.message.compiledInstructions) {
    const program = opts.accountKeys[ix.programIdIndex];
    if (!program) {
      return { ok: false, error: `tx: program id index ${ix.programIdIndex} unresolved (fail closed)` };
    }
    const pid = program.toBase58();
    if (!allow.has(pid)) {
      return { ok: false, error: `tx: program ${pid} is not on the allowlist` };
    }
    for (const idx of ix.accountKeyIndexes) {
      if (opts.accountKeys[idx] == null) {
        return { ok: false, error: `tx: account index ${idx} unresolved (fail closed)` };
      }
    }
    if (TOKEN_PROGRAMS.has(pid)) {
      const disc = ix.data?.[0];
      if (disc == null) return { ok: false, error: "tx: token instruction missing discriminator" };
      if (FORBIDDEN_TOKEN_DISCRIMINATORS.has(disc)) {
        return { ok: false, error: `tx: forbidden token instruction discriminator ${disc}` };
      }
    }
  }
  return { ok: true, accountKeys: opts.accountKeys };
}

export function accountKeysFromLoadedMessage(
  tx: VersionedTransaction,
  tables: AddressLookupTableAccount[],
): PublicKey[] | null {
  try {
    const lookups = tx.message.addressTableLookups ?? [];
    if (lookups.length && tables.length !== lookups.length) return null;
    const keys = lookups.length
      ? tx.message.getAccountKeys({ addressLookupTableAccounts: tables })
      : tx.message.getAccountKeys();
    const out: PublicKey[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys.get(i);
      if (!k) return null;
      out.push(k);
    }
    return out;
  } catch {
    return null;
  }
}
