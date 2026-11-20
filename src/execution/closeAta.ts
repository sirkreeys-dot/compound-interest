/**
 * Close an empty SPL / Token-2022 account so the rent-exempt lamports return
 * to the wallet. Instruction layout matches Token.CloseAccount (index 9).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { rpcConnection } from "../utils/http.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAta,
  parseSplTokenAmount,
} from "../security/simulateSwap.js";

export function closeAccountInstruction(opts: {
  account: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: opts.programId ?? TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: opts.account, isSigner: false, isWritable: true },
      { pubkey: opts.destination, isSigner: false, isWritable: true },
      { pubkey: opts.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export interface CloseAtaResult {
  ok: boolean;
  closed: boolean;
  rentLamports?: number;
  error?: string;
  signature?: string;
}

export async function closeEmptyTokenAccount(opts: {
  rpcUrl: string;
  owner: Keypair;
  mint: string;
  connection?: Connection;
  send?: (tx: Transaction, payer: Keypair) => Promise<string>;
}): Promise<CloseAtaResult> {
  if (!opts.rpcUrl || /127\.0\.0\.1|localhost/i.test(opts.rpcUrl)) {
    return { ok: false, closed: false, error: "refusing to close ATA on loopback RPC" };
  }
  let mintPk: PublicKey;
  try {
    mintPk = new PublicKey(opts.mint);
  } catch {
    return { ok: false, closed: false, error: "invalid mint" };
  }
  const conn =
    opts.connection ?? rpcConnection(opts.rpcUrl);
  try {
    const mintInfo = await conn.getAccountInfo(mintPk, "confirmed");
    if (!mintInfo) return { ok: true, closed: false, error: "mint account missing" };
    const program = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    const ata = deriveAta(opts.owner.publicKey, mintPk, program);
    const info = await conn.getAccountInfo(ata, "confirmed");
    if (!info) return { ok: true, closed: false };
    if (info.data.length >= 72) {
      const amount = parseSplTokenAmount(info.data.toString("base64"));
      if (amount > 0n) {
        return { ok: true, closed: false, error: "token balance still non-zero" };
      }
    }
    const rentLamports = info.lamports;
    const ix = closeAccountInstruction({
      account: ata,
      destination: opts.owner.publicKey,
      owner: opts.owner.publicKey,
      programId: program,
    });
    const tx = new Transaction().add(ix);
    const signature = opts.send
      ? await opts.send(tx, opts.owner)
      : await sendAndConfirmTransaction(conn, tx, [opts.owner], { commitment: "confirmed" });
    return { ok: true, closed: true, rentLamports, signature };
  } catch (e) {
    return {
      ok: false,
      closed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
