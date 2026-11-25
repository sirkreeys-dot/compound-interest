import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { loadAppConfig } from "../src/config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { associatedTokenAddress, checkTopLevelFundFlow, WSOL_MINT } from "../src/security/fundFlow.js";
import { inspectSwapInstructions } from "../src/security/programAllowlist.js";
import { afterBlockhashCheck, outAmountDiverged, sameMessageBytes } from "../src/security/simGap.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

function v0(payer: Keypair, ixs: TransactionInstruction[]): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

function inspect(tx: VersionedTransaction, owner: PublicKey, mints: string[]) {
  const keys = tx.message.staticAccountKeys;
  const allow = loadAppConfig(path.join(root, "config.example.yaml")).risk.solanaProgramAllowlist;
  return inspectSwapInstructions({ tx, accountKeys: keys, ourPubkey: owner, allowlist: allow, mints });
}

describe("top-level fund destinations", () => {
  const payer = Keypair.generate();
  const stranger = Keypair.generate().publicKey;
  const wsolAta = associatedTokenAddress(payer.publicKey, new PublicKey(WSOL_MINT), TOKEN);
  const output = Keypair.generate().publicKey;
  const outAta = associatedTokenAddress(payer.publicKey, output, TOKEN);

  it("rejects a SOL transfer, a foreign token transfer, a foreign close, and setAuthority", () => {
    const sol = v0(payer, [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger, lamports: 1 }),
    ]);
    const solR = inspect(sol, payer.publicKey, []);
    assert.equal(solR.ok, false);
    if (!solR.ok) assert.match(solR.error, /system transfer/);

    const spl = v0(payer, [
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: stranger, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ]);
    const splR = inspect(spl, payer.publicKey, [WSOL_MINT]);
    assert.equal(splR.ok, false);
    if (!splR.ok) assert.match(splR.error, /token transfer/);

    const close = v0(payer, [
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: stranger, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([9]),
      }),
    ]);
    const closeR = inspect(close, payer.publicKey, [WSOL_MINT]);
    assert.equal(closeR.ok, false);
    if (!closeR.ok) assert.match(closeR.error, /closeAccount/);

    const auth = v0(payer, [
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([6, 2, 0]),
      }),
    ]);
    const authR = inspect(auth, payer.publicKey, [WSOL_MINT]);
    assert.equal(authR.ok, false);
    if (!authR.ok) assert.match(authR.error, /setAuthority/);
  });

  it("accepts a route whose top-level transfers stay with our wallet and ATA", () => {
    const tx = v0(payer, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
        data: Buffer.from([17]),
      }),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: outAta, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
      }),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([9]),
      }),
      new TransactionInstruction({
        programId: JUP,
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([1, 0]),
      }),
    ]);
    const result = inspect(tx, payer.publicKey, [WSOL_MINT, output.toBase58()]);
    assert.equal(result.ok, true);
    const direct = checkTopLevelFundFlow({
      instructions: [],
      owner: payer.publicKey,
      mints: [],
    });
    assert.equal(direct.ok, true);
  });
});

describe("sim versus the transaction that would be signed", () => {
  it("aborts when the order out-amount moves beyond slippage", () => {
    assert.equal(outAmountDiverged("10000", "10000", 300), false);
    assert.equal(outAmountDiverged("10000", "9700", 300), false);
    assert.equal(outAmountDiverged("10000", "9699", 300), true);
    assert.equal(outAmountDiverged("nope", "10000", 300), true);
  });

  it("re-quotes an expired blockhash once, then aborts", () => {
    assert.equal(afterBlockhashCheck(0, true), "sign");
    assert.equal(afterBlockhashCheck(0, false), "requote");
    assert.equal(afterBlockhashCheck(1, true), "sign");
    assert.equal(afterBlockhashCheck(1, false), "abort");
    assert.equal(afterBlockhashCheck(2, false), "abort");
  });

  it("keeps the message bytes identical from simulation to sign", () => {
    const payer = Keypair.generate();
    const tx = v0(payer, [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
    ]);
    const before = new Uint8Array(tx.message.serialize());
    tx.sign([payer]);
    const after = new Uint8Array(tx.message.serialize());
    assert.equal(sameMessageBytes(before, after), true);
    after[0] = after[0]! ^ 1;
    assert.equal(sameMessageBytes(before, after), false);
  });
});
