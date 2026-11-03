/**
 * Pre-sign Solana swap simulation.
 * Fail-closed: any RPC/sim error or unexpected balance change refuses the signature.
 */
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";
import { log } from "../utils/logger.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function deriveAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/** Parse SPL / Token-2022 account amount (u64 LE at offset 64). */
export function parseSplTokenAmount(dataBase64: string): bigint {
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length < 72) return 0n;
  return buf.readBigUInt64LE(64);
}

export function parseSplTokenOwner(dataBase64: string): PublicKey | null {
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length < 64) return null;
  try {
    return new PublicKey(buf.subarray(32, 64));
  } catch {
    return null;
  }
}

export function parseSplTokenMint(dataBase64: string): PublicKey | null {
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length < 32) return null;
  try {
    return new PublicKey(buf.subarray(0, 32));
  } catch {
    return null;
  }
}

export interface SimBalanceSnapshot {
  /** lamports by pubkey base58 */
  lamports: Map<string, number>;
  /** raw token amount by token-account pubkey */
  tokenAmounts: Map<string, bigint>;
  /** token-account pubkey -> mint base58 (only wallet-owned) */
  tokenMints: Map<string, string>;
}

export type SimValidateOk = { ok: true; detail: string };
export type SimValidateErr = { ok: false; error: string };
export type SimValidateResult = SimValidateOk | SimValidateErr;

export interface EvaluateSimOpts {
  ourWallet: string;
  inputMint: string;
  outputMint: string;
  expectedInAmount: bigint;
  otherAmountThreshold: bigint | null;
  /** Extra lamports beyond expected SOL input+fee that we tolerate. Default 50_000 (~0.00005 SOL). */
  maxExtraLamports: number;
  /** Extra token-raw units beyond expectedInAmount tolerated on input ATA. Default 0. */
  maxExtraTokenOutflow: bigint;
  pre: SimBalanceSnapshot;
  /** Post-sim account infos keyed by address, in the same order as requested (null = missing). */
  postAccounts: Array<{ address: string; lamports: number; dataBase64: string | null } | null>;
  /** Addresses we asked the simulator to return (parallel to postAccounts). */
  watchedAddresses: string[];
  inputTokenAccount: string | null;
  outputTokenAccount: string | null;
}

/**
 * Pure balance-diff checks used by simulateAndValidateSwap (also unit-tested with fixtures).
 */
export function evaluateSimulatedBalances(opts: EvaluateSimOpts): SimValidateResult {
  const postLamports = new Map<string, number>();
  const postToken = new Map<string, bigint>();

  for (let i = 0; i < opts.watchedAddresses.length; i++) {
    const addr = opts.watchedAddresses[i]!;
    const acc = opts.postAccounts[i];
    if (!acc) {
      // Account closed or missing after sim — treat token amount as 0, lamports 0
      postLamports.set(addr, 0);
      if (opts.pre.tokenAmounts.has(addr) || addr === opts.inputTokenAccount || addr === opts.outputTokenAccount) {
        postToken.set(addr, 0n);
      }
      continue;
    }
    postLamports.set(addr, acc.lamports);
    if (acc.dataBase64 && acc.dataBase64.length > 0) {
      // Heuristic: token accounts are >= 165 bytes typically; still try parse when we track them
      if (
        opts.pre.tokenAmounts.has(addr) ||
        addr === opts.inputTokenAccount ||
        addr === opts.outputTokenAccount ||
        opts.pre.tokenMints.has(addr)
      ) {
        postToken.set(addr, parseSplTokenAmount(acc.dataBase64));
      }
    } else if (opts.pre.tokenAmounts.has(addr)) {
      postToken.set(addr, 0n);
    }
  }

  const isNativeIn = opts.inputMint === WSOL_MINT;
  const isNativeOut = opts.outputMint === WSOL_MINT;

  // --- SOL / wallet lamports ---
  const preSol = opts.pre.lamports.get(opts.ourWallet) ?? 0;
  const postSol = postLamports.get(opts.ourWallet);
  if (postSol == null) {
    return { ok: false, error: "sim: wallet lamports missing from simulation accounts" };
  }
  const solDrop = BigInt(Math.max(0, preSol - postSol));
  if (isNativeIn) {
    const maxDrop = opts.expectedInAmount + BigInt(opts.maxExtraLamports);
    if (solDrop > maxDrop) {
      return {
        ok: false,
        error: `sim: SOL outflow ${solDrop} > expectedIn ${opts.expectedInAmount} + feeTol ${opts.maxExtraLamports}`,
      };
    }
  } else {
    // Fee-only SOL spend
    if (solDrop > BigInt(opts.maxExtraLamports)) {
      return {
        ok: false,
        error: `sim: unexpected SOL fee outflow ${solDrop} > maxExtraLamports ${opts.maxExtraLamports}`,
      };
    }
  }

  // --- Input token ATA ---
  if (!isNativeIn) {
    if (!opts.inputTokenAccount) {
      return { ok: false, error: "sim: input token account not derived" };
    }
    const preIn = opts.pre.tokenAmounts.get(opts.inputTokenAccount) ?? 0n;
    const postIn = postToken.get(opts.inputTokenAccount) ?? 0n;
    const drop = preIn > postIn ? preIn - postIn : 0n;
    const maxDrop = opts.expectedInAmount + opts.maxExtraTokenOutflow;
    if (drop > maxDrop) {
      return {
        ok: false,
        error: `sim: input token outflow ${drop} > expected ${opts.expectedInAmount} + tol ${opts.maxExtraTokenOutflow}`,
      };
    }
  }

  // --- Output token increase ---
  if (!isNativeOut) {
    if (!opts.outputTokenAccount) {
      return { ok: false, error: "sim: output token account not derived" };
    }
    const preOut = opts.pre.tokenAmounts.get(opts.outputTokenAccount) ?? 0n;
    const postOut = postToken.get(opts.outputTokenAccount) ?? 0n;
    const gain = postOut > preOut ? postOut - preOut : 0n;
    if (opts.otherAmountThreshold != null && gain < opts.otherAmountThreshold) {
      return {
        ok: false,
        error: `sim: output gain ${gain} < otherAmountThreshold ${opts.otherAmountThreshold}`,
      };
    }
  } else {
    // Native SOL out: wallet lamports should increase by at least threshold (net of fees is hard);
    // require postSol - (preSol - fees) roughly: simply require postSol + expectedFeeFloor >= preSol + threshold
    // Conservative: (postSol + maxExtraLamports) - preSol >= otherAmountThreshold when selling to SOL
    if (opts.otherAmountThreshold != null) {
      const solGain = BigInt(Math.max(0, postSol - preSol));
      // When selling token→SOL, we also paid fees, so gain may be threshold - fees.
      // Accept if solGain + maxExtraLamports >= threshold.
      if (solGain + BigInt(opts.maxExtraLamports) < opts.otherAmountThreshold) {
        return {
          ok: false,
          error: `sim: SOL gain ${solGain} (+feeTol) < otherAmountThreshold ${opts.otherAmountThreshold}`,
        };
      }
    }
  }

  // --- No other wallet-owned token account may lose balance ---
  for (const [ata, preAmt] of opts.pre.tokenAmounts) {
    if (ata === opts.inputTokenAccount || ata === opts.outputTokenAccount) continue;
    const postAmt = postToken.has(ata) ? postToken.get(ata)! : preAmt;
    if (postAmt < preAmt) {
      const mint = opts.pre.tokenMints.get(ata) ?? "?";
      return {
        ok: false,
        error: `sim: unexpected drain of other token account ${ata.slice(0, 8)}… mint=${mint.slice(0, 8)}… drop=${preAmt - postAmt}`,
      };
    }
  }

  return {
    ok: true,
    detail: `sim ok solDrop=${solDrop} watched=${opts.watchedAddresses.length}`,
  };
}

export interface SimulateSwapOpts {
  rpcUrl: string;
  tx: VersionedTransaction;
  ourPubkey: PublicKey;
  inputMint: string;
  outputMint: string;
  expectedInAmount: string;
  otherAmountThreshold?: string | null;
  maxExtraLamports?: number;
  maxExtraTokenOutflow?: bigint;
  /** Injected for tests */
  connection?: Connection;
  simulateImpl?: (
    tx: VersionedTransaction,
    config: {
      sigVerify: boolean;
      replaceRecentBlockhash: boolean;
      accounts: { encoding: "base64"; addresses: string[] };
    },
  ) => Promise<{ value: SimulatedTransactionResponse }>;
  getMultipleAccountsImpl?: (
    keys: PublicKey[],
  ) => Promise<Array<{ lamports: number; data: Buffer; owner: PublicKey } | null>>;
}

export async function simulateAndValidateSwap(
  opts: SimulateSwapOpts,
): Promise<SimValidateResult> {
  const maxExtraLamports = opts.maxExtraLamports ?? 50_000;
  const maxExtraTokenOutflow = opts.maxExtraTokenOutflow ?? 0n;
  let expectedIn: bigint;
  try {
    expectedIn = BigInt(opts.expectedInAmount);
  } catch {
    return { ok: false, error: "sim: invalid expectedInAmount" };
  }
  let minOut: bigint | null = null;
  if (opts.otherAmountThreshold && /^\d+$/.test(opts.otherAmountThreshold)) {
    minOut = BigInt(opts.otherAmountThreshold);
  }

  const conn =
    opts.connection ??
    new Connection(opts.rpcUrl, {
      commitment: "confirmed",
      // Avoid ws side-effects in Node for one-shot sim
      disableRetryOnRateLimit: false,
    });

  const inputMintPk = new PublicKey(opts.inputMint);
  const outputMintPk = new PublicKey(opts.outputMint);
  const isNativeIn = opts.inputMint === WSOL_MINT;
  const isNativeOut = opts.outputMint === WSOL_MINT;

  // Resolve mint programs for ATA derivation
  const mintInfos = await (opts.getMultipleAccountsImpl
    ? opts.getMultipleAccountsImpl([inputMintPk, outputMintPk])
    : conn.getMultipleAccountsInfo([inputMintPk, outputMintPk], "confirmed").then((arr) =>
        arr.map((a) =>
          a
            ? { lamports: a.lamports, data: Buffer.from(a.data), owner: a.owner }
            : null,
        ),
      ));

  const inputTokenProgram =
    mintInfos[0]?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const outputTokenProgram =
    mintInfos[1]?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const inputAta = isNativeIn ? null : deriveAta(opts.ourPubkey, inputMintPk, inputTokenProgram);
  const outputAta = isNativeOut
    ? null
    : deriveAta(opts.ourPubkey, outputMintPk, outputTokenProgram);

  // Collect writable keys from the tx that we may need to watch
  const keys = opts.tx.message.getAccountKeys();
  const numWritable =
    opts.tx.message.header.numRequiredSignatures -
    opts.tx.message.header.numReadonlySignedAccounts +
    (keys.length -
      opts.tx.message.header.numRequiredSignatures -
      opts.tx.message.header.numReadonlyUnsignedAccounts);
  void numWritable;

  const candidateAtas: PublicKey[] = [];
  const watched: PublicKey[] = [opts.ourPubkey];
  if (inputAta) {
    watched.push(inputAta);
    candidateAtas.push(inputAta);
  }
  if (outputAta) {
    watched.push(outputAta);
    candidateAtas.push(outputAta);
  }

  // Include other static account keys (no ALT resolution for lookups — static keys only)
  for (let i = 0; i < keys.length; i++) {
    const k = keys.get(i);
    if (!k) continue;
    if (k.equals(opts.ourPubkey)) continue;
    if (inputAta && k.equals(inputAta)) continue;
    if (outputAta && k.equals(outputAta)) continue;
    // We'll filter to our token accounts after fetch
    watched.push(k);
  }

  // Dedupe
  const seen = new Set<string>();
  const watchedUnique: PublicKey[] = [];
  for (const k of watched) {
    const s = k.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    watchedUnique.push(k);
  }

  const preInfos = await (opts.getMultipleAccountsImpl
    ? opts.getMultipleAccountsImpl(watchedUnique)
    : conn.getMultipleAccountsInfo(watchedUnique, "confirmed").then((arr) =>
        arr.map((a) =>
          a
            ? { lamports: a.lamports, data: Buffer.from(a.data), owner: a.owner }
            : null,
        ),
      ));

  const pre: SimBalanceSnapshot = {
    lamports: new Map(),
    tokenAmounts: new Map(),
    tokenMints: new Map(),
  };
  const ourWallet = opts.ourPubkey.toBase58();
  const inputTokenAccount = inputAta?.toBase58() ?? null;
  const outputTokenAccount = outputAta?.toBase58() ?? null;
  const watchForSim: string[] = [ourWallet];
  if (inputTokenAccount) watchForSim.push(inputTokenAccount);
  if (outputTokenAccount) watchForSim.push(outputTokenAccount);

  for (let i = 0; i < watchedUnique.length; i++) {
    const addr = watchedUnique[i]!.toBase58();
    const info = preInfos[i];
    if (!info) continue;
    pre.lamports.set(addr, info.lamports);
    const isTokenProg =
      info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID);
    if (isTokenProg && info.data.length >= 72) {
      const owner = parseSplTokenOwner(info.data.toString("base64"));
      const mint = parseSplTokenMint(info.data.toString("base64"));
      if (owner && owner.equals(opts.ourPubkey) && mint) {
        const amount = parseSplTokenAmount(info.data.toString("base64"));
        pre.tokenAmounts.set(addr, amount);
        pre.tokenMints.set(addr, mint.toBase58());
        if (!watchForSim.includes(addr)) watchForSim.push(addr);
      }
    }
  }
  // Ensure wallet lamports present
  if (!pre.lamports.has(ourWallet)) {
    // Wallet might be missing from getMultiple if somehow — fail closed
    return { ok: false, error: "sim: could not fetch wallet account pre-balance" };
  }

  const addresses = watchForSim;
  let simValue: SimulatedTransactionResponse;
  try {
    if (opts.simulateImpl) {
      const res = await opts.simulateImpl(opts.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses },
      });
      simValue = res.value;
    } else {
      const res = await conn.simulateTransaction(opts.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses },
      });
      simValue = res.value;
    }
  } catch (e) {
    return {
      ok: false,
      error: `sim: RPC simulateTransaction threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (simValue.err) {
    return {
      ok: false,
      error: `sim: transaction simulation error: ${JSON.stringify(simValue.err)}`,
    };
  }

  const postAccounts: Array<{
    address: string;
    lamports: number;
    dataBase64: string | null;
  } | null> = [];
  const returned = simValue.accounts ?? [];
  for (let i = 0; i < addresses.length; i++) {
    const a = returned[i];
    if (!a) {
      postAccounts.push(null);
      continue;
    }
    const dataBase64 =
      Array.isArray(a.data) && typeof a.data[0] === "string" ? a.data[0] : null;
    postAccounts.push({
      address: addresses[i]!,
      lamports: a.lamports,
      dataBase64,
    });
  }

  const result = evaluateSimulatedBalances({
    ourWallet,
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    expectedInAmount: expectedIn,
    otherAmountThreshold: minOut,
    maxExtraLamports,
    maxExtraTokenOutflow,
    pre,
    postAccounts,
    watchedAddresses: addresses,
    inputTokenAccount,
    outputTokenAccount,
  });

  if (!result.ok) {
    log.warn(`simulateAndValidateSwap refused: ${result.error}`);
  } else {
    log.info(`simulateAndValidateSwap ${result.detail}`);
  }
  return result;
}
