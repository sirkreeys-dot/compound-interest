/**
 * Round-trip sell simulation helpers.
 * A sell of a token the wallet does not hold yet is simulated in the same
 * transaction as the buy (sigVerify false, replaceRecentBlockhash true) so the
 * buy's output exists before the sell runs. No private key is required.
 */
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

export type SellSimClass = "ok" | "no_balance" | "honeypot";

/** Quote success is not a sell. Only a simulation error class decides. */
export function classifySellSimulation(err: unknown, logs?: string[] | null): SellSimClass {
  if (err == null) return "ok";
  const text = `${JSON.stringify(err)}\n${(logs ?? []).join("\n")}`.toLowerCase();
  if (
    text.includes("insufficient") ||
    text.includes("accountnotfound") ||
    text.includes("account not found") ||
    text.includes("could not find") ||
    /custom program error: 0x1(?![0-9a-f])/i.test(text)
  ) {
    return "no_balance";
  }
  return "honeypot";
}

function writableStatic(index: number, header: VersionedTransaction["message"]["header"], staticLen: number): boolean {
  const signed = header.numRequiredSignatures;
  if (index < signed) return index < signed - header.numReadonlySignedAccounts;
  return index < staticLen - header.numReadonlyUnsignedAccounts;
}

function accountIsWritable(tx: VersionedTransaction, index: number): boolean {
  const staticLen = tx.message.staticAccountKeys.length;
  if (index < staticLen) return writableStatic(index, tx.message.header, staticLen);
  let writableLookups = 0;
  for (const lookup of tx.message.addressTableLookups ?? []) {
    writableLookups += lookup.writableIndexes.length;
  }
  return index < staticLen + writableLookups;
}

export function decompileInstructions(tx: VersionedTransaction, keys: PublicKey[]): TransactionInstruction[] {
  return tx.message.compiledInstructions.map((ix) => {
    const programId = keys[ix.programIdIndex];
    if (!programId) throw new Error("sell_sim: program id unresolved");
    return new TransactionInstruction({
      programId,
      keys: ix.accountKeyIndexes.map((i) => {
        const pubkey = keys[i];
        if (!pubkey) throw new Error("sell_sim: account unresolved");
        return {
          pubkey,
          isSigner: false,
          isWritable: accountIsWritable(tx, i),
        };
      }),
      data: Buffer.from(ix.data),
    });
  });
}

/**
 * One unsigned transaction: buy instructions, then sell instructions.
 * Simulation with sigVerify false runs them in order, so the sell sees the buy's tokens.
 */
export function combineBuyAndSellForSim(opts: {
  buy: VersionedTransaction;
  sell: VersionedTransaction;
  buyKeys: PublicKey[];
  sellKeys: PublicKey[];
  payer: PublicKey;
  lookupTables?: AddressLookupTableAccount[];
}): VersionedTransaction {
  const buyIxs = decompileInstructions(opts.buy, opts.buyKeys);
  const sellIxs = decompileInstructions(opts.sell, opts.sellKeys);
  for (const ix of [...buyIxs, ...sellIxs]) {
    for (const key of ix.keys) {
      if (key.pubkey.equals(opts.payer)) key.isSigner = true;
    }
  }
  const msg = new TransactionMessage({
    payerKey: opts.payer,
    recentBlockhash: opts.buy.message.recentBlockhash,
    instructions: [...buyIxs, ...sellIxs],
  }).compileToV0Message(opts.lookupTables ?? []);
  return new VersionedTransaction(msg);
}
