import { PublicKey } from "@solana/web3.js";
import { rpcConnection, withRpcFailover } from "../utils/http.js";

/** True when the balance is strictly above the ceiling. Equality is allowed. */
export function walletExceedsCeiling(lamports: number, maxSol: number): boolean {
  return lamports / 1_000_000_000 > maxSol;
}

/** Refuse live mode when the hot wallet holds more than the configured ceiling. */
export async function assertHotWalletCeiling(opts: {
  rpcUrl: string;
  secondaryUrl?: string;
  owner: string;
  maxSol: number;
}): Promise<void> {
  let lamports: number;
  try {
    lamports = await withRpcFailover([opts.rpcUrl, opts.secondaryUrl], async (url) => {
      const balance = await rpcConnection(url).getBalance(new PublicKey(opts.owner), "confirmed");
      if (!Number.isFinite(balance)) throw new Error("balance was not a number");
      return balance;
    });
  } catch {
    throw new Error("LIVE refused: could not read wallet balance (fail closed)");
  }
  const sol = lamports / 1_000_000_000;
  if (walletExceedsCeiling(lamports, opts.maxSol)) {
    throw new Error(`LIVE refused: wallet holds ${sol} SOL which is above maxWalletSol ${opts.maxSol}`);
  }
}
