/**
 * Round-trip sell simulation helpers.
 * A sell of a token the wallet does not hold yet is simulated in the same
 * transaction as the buy (sigVerify false, replaceRecentBlockhash true) so the
 * buy's output exists before the sell runs. No private key is required.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

export type SellSimClass = "ok" | "no_balance" | "honeypot";

/** passed: simulation succeeded. skipped: could not run (not a pass). failed: ran and refused. */
export type SellSimOutcome = "passed" | "skipped" | "failed";

export type SellSimReason =
  | "simulated"
  | "no_public_key"
  | "no_rpc"
  | "no_balance"
  | "no_route"
  | "honeypot"
  | "high_tax"
  | "sim_error"
  | "timeout"
  | "allowlist";

const SKIP_REASONS = new Set<SellSimReason>(["no_public_key", "no_rpc", "no_balance"]);

export function sellSimVerdict(
  reason: SellSimReason,
  live: boolean,
): { outcome: SellSimOutcome; refuseBuy: boolean } {
  if (reason === "simulated") return { outcome: "passed", refuseBuy: false };
  if (SKIP_REASONS.has(reason)) return { outcome: "skipped", refuseBuy: live };
  return { outcome: "failed", refuseBuy: true };
}

/** One line per outcome. "skipped" is never the same wording as "passed". */
export function sellSimLogLine(reason: SellSimReason, live: boolean, detail: string): string {
  const { outcome } = sellSimVerdict(reason, live);
  return `sell_sim outcome=${outcome} reason=${reason} mode=${live ? "live" : "dry_run"} detail=${detail}`;
}

/** A missing RPC body is a failure, not a pass. `err: null` is a successful simulation. */
export function sellSimReasonFromRpc(
  value: { err?: unknown; logs?: string[] | null } | null | undefined,
): SellSimReason {
  if (value == null) return "sim_error";
  const klass = classifySellSimulation(value.err, value.logs);
  if (klass === "ok") return "simulated";
  if (klass === "no_balance") return "no_balance";
  return "honeypot";
}

/** Serialized v0 transactions must stay within this many bytes. */
export const SIM_TX_SIZE_LIMIT = 1232;

/** Sell the buy's minimum out when Jupiter provides it, otherwise the quoted out. */
export function roundTripSellAmount(outAmount: string | undefined, minOut: string | null | undefined): string | null {
  if (minOut && /^\d+$/.test(minOut) && minOut !== "0") return minOut;
  if (outAmount && /^\d+$/.test(outAmount) && outAmount !== "0") return outAmount;
  return null;
}

export interface JupiterInstructionJson {
  programId: string;
  accounts?: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export interface SwapInstructionsBody {
  computeBudgetInstructions?: JupiterInstructionJson[] | null;
  setupInstructions?: JupiterInstructionJson[] | null;
  swapInstruction?: JupiterInstructionJson | null;
  cleanupInstruction?: JupiterInstructionJson | null;
  otherInstructions?: JupiterInstructionJson[] | null;
  addressLookupTableAddresses?: string[] | null;
}

export function jupiterInstruction(raw: JupiterInstructionJson): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: (raw.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(raw.data, "base64"),
  });
}

/** Lookup tables named by Jupiter. Nothing is read from config. */
export function altAddressesFromSwapBodies(bodies: SwapInstructionsBody[]): string[] {
  const out: string[] = [];
  for (const body of bodies) {
    const listed = [
      ...(body.addressLookupTableAddresses ?? []),
      ...((body as { addressLookupTableAccounts?: string[] | null }).addressLookupTableAccounts ?? []),
    ];
    for (const addr of listed) {
      if (addr && !out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

/** First quote uses Jupiter's default. The next two ask for a shorter route. */
export const ROUND_TRIP_ACCOUNT_CAPS: Array<number | undefined> = [undefined, 40, 30];

export function dedupeInstructions(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const seen = new Set<string>();
  const out: TransactionInstruction[] = [];
  for (const ix of ixs) {
    const id = [
      ix.programId.toBase58(),
      Buffer.from(ix.data).toString("base64"),
      ...ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 1 : 0}:${k.isWritable ? 1 : 0}`),
    ].join("|");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ix);
  }
  return out;
}

/** Setup, swap, then cleanup. Compute-budget instructions are omitted; the sim tx sets one limit for both legs. */
export function instructionsFromSwapBody(body: SwapInstructionsBody): TransactionInstruction[] {
  const raw = [
    ...(body.setupInstructions ?? []),
    ...(body.swapInstruction ? [body.swapInstruction] : []),
    ...(body.cleanupInstruction ? [body.cleanupInstruction] : []),
    ...(body.otherInstructions ?? []),
  ];
  return raw.map(jupiterInstruction);
}

/**
 * One unsigned v0 transaction: buy instructions, then sell instructions.
 * The caller simulates it with sigVerify false and replaceRecentBlockhash true.
 */
export function compileRoundTripForSim(opts: {
  buyIxs: TransactionInstruction[];
  sellIxs: TransactionInstruction[];
  payer: PublicKey;
  lookupTables?: AddressLookupTableAccount[];
  recentBlockhash: string;
}): { tx: VersionedTransaction; bytes: number } {
  const instructions = dedupeInstructions([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...opts.buyIxs,
    ...opts.sellIxs,
  ]);
  const tables: AddressLookupTableAccount[] = [];
  const seenTables = new Set<string>();
  for (const table of opts.lookupTables ?? []) {
    const key = table.key.toBase58();
    if (seenTables.has(key)) continue;
    seenTables.add(key);
    tables.push(table);
  }
  let tx: VersionedTransaction;
  let bytes = SIM_TX_SIZE_LIMIT + 1;
  try {
    const msg = new TransactionMessage({
      payerKey: opts.payer,
      recentBlockhash: opts.recentBlockhash,
      instructions,
    }).compileToV0Message(tables);
    tx = new VersionedTransaction(msg);
    bytes = tx.serialize().length;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`round_trip: combined transaction exceeds ${SIM_TX_SIZE_LIMIT} bytes (${detail})`);
  }
  if (bytes > SIM_TX_SIZE_LIMIT) {
    throw new Error(`round_trip: combined transaction is ${bytes} bytes > ${SIM_TX_SIZE_LIMIT}`);
  }
  return { tx, bytes };
}

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
