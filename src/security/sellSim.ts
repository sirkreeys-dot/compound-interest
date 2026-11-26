/**
 * Round-trip sell simulation helpers.
 * A sell of a token the wallet does not hold yet is simulated in the same
 * transaction as the buy (sigVerify false, replaceRecentBlockhash true) so the
 * buy's output exists before the sell runs. No private key is required.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

export type SellSimClass = "ok" | "no_balance" | "honeypot" | "inconclusive";

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
  | "sim_inconclusive"
  | "rate_limited"
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
  if (klass === "inconclusive") return "sim_inconclusive";
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

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function tokenProgramUsed(ixs: TransactionInstruction[]): PublicKey {
  for (const ix of ixs) {
    if (ix.programId.equals(TOKEN_2022_PROGRAM)) return TOKEN_2022_PROGRAM;
    if (ix.keys.some((key) => key.pubkey.equals(TOKEN_2022_PROGRAM))) return TOKEN_2022_PROGRAM;
  }
  return TOKEN_PROGRAM;
}

function ataAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

/** CreateIdempotent (discriminator 1) so a combined sell sees the buy's output account. */
export function createAtaIdempotentIx(
  payer: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataAddress(payer, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function ensureAtaCreates(
  payer: PublicKey,
  outputMint: PublicKey | undefined,
  ixs: TransactionInstruction[],
): TransactionInstruction[] {
  if (!outputMint) return [];
  const program = tokenProgramUsed(ixs);
  const needed = [WSOL_MINT, outputMint];
  const creates: TransactionInstruction[] = [];
  for (const mint of needed) {
    const tokenProgram = mint.equals(WSOL_MINT) ? TOKEN_PROGRAM : program;
    const ata = ataAddress(payer, mint, tokenProgram);
    const present = ixs.some(
      (ix) => ix.programId.equals(ATA_PROGRAM) && ix.keys.some((key) => key.pubkey.equals(ata)),
    );
    if (!present) creates.push(createAtaIdempotentIx(payer, mint, tokenProgram));
  }
  return creates;
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
  /** Output mint of the buy. A missing ATA create is inserted so the sell leg has an account. */
  outputMint?: PublicKey;
}): { tx: VersionedTransaction; bytes: number } {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...ensureAtaCreates(opts.payer, opts.outputMint, [...opts.buyIxs, ...opts.sellIxs]),
    ...dedupeInstructions(opts.buyIxs),
    ...dedupeInstructions(opts.sellIxs),
  ];
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

/** First inconclusive simulation is rebuilt once. A second one is the final refusal. */
export function nextSimAction(reason: SellSimReason, attempt: number): "done" | "requote" {
  if (reason === "sim_inconclusive" && attempt === 0) return "requote";
  return "done";
}

/**
 * Jupiter custom codes that are not a honeypot.
 * 6025 InvalidTokenAccount is documented by Jupiter:
 * https://developers.jup.ag/docs/swap/v1/common-errors
 * and the program IDL at
 * https://solscan.io/account/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4#programIdl
 * It means a token account in the instruction is uninitialized or not the expected one.
 * That happens when the buy and sell legs are built separately and then concatenated.
 */
const JUPITER_INCONCLUSIVE = new Set([6001, 6008, 6014, 6017, 6024, 6025]);

export function jupiterCustomCode(err: unknown): number | null {
  const text = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const match = text.match(/"Custom"\s*:\s*(\d+)/);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

/** A quote/order failure that is a 429 is not "no route". */
export function quoteFailureReason(error: string): "rate_limited" | "no_route" {
  if (/\b429\b/i.test(error) || /too many requests/i.test(error) || /rate_limited/i.test(error)) {
    return "rate_limited";
  }
  return "no_route";
}

/** Quote success is not a sell. Only a simulation error class decides. */
export function classifySellSimulation(err: unknown, logs?: string[] | null): SellSimClass {
  if (err == null) return "ok";
  const code = jupiterCustomCode(err);
  if (code != null && JUPITER_INCONCLUSIVE.has(code)) return "inconclusive";
  const text = `${JSON.stringify(err)}\n${(logs ?? []).join("\n")}`.toLowerCase();
  if (
    /invalidaccountdata|accountnotinitialized|uninitializedaccount|uninitializedstate/i.test(text)
  ) {
    return "inconclusive";
  }
  if (
    text.includes("insufficient") ||
    text.includes("accountnotfound") ||
    text.includes("account not found") ||
    text.includes("could not find") ||
    /custom program error: 0x1(?![0-9a-f])/i.test(text)
  ) {
    return "no_balance";
  }
  if (
    code === 17 ||
    text.includes("account is frozen") ||
    text.includes("accountfrozen") ||
    text.includes("transfer hook") ||
    text.includes("transferhook") ||
    text.includes("non-transferable") ||
    text.includes("nontransferable")
  ) {
    return "honeypot";
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
