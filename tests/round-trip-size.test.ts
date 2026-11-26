import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ROUND_TRIP_ACCOUNT_CAPS,
  SIM_TX_SIZE_LIMIT,
  altAddressesFromSwapBodies,
  compileRoundTripForSim,
} from "../src/security/sellSim.js";
import { sellSimVerdict } from "../src/security/sellSim.js";
import { jupiterFetch, jupiterHeaders, JupiterLimiter, ladderStep, rateLimitBackoffMs } from "../src/execution/jupiterLimit.js";

function alt(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

describe("round-trip transaction size", () => {
  it("an oversized pair of legs fits once Jupiter lookup tables are compiled in", () => {
    const payer = Keypair.generate();
    const extras = Array.from({ length: 45 }, () => Keypair.generate().publicKey);
    const leg = (mark: number) =>
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          ...extras.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        ],
        data: Buffer.from([mark]),
      });
    const blockhash = Keypair.generate().publicKey.toBase58();
    assert.throws(
      () =>
        compileRoundTripForSim({
          buyIxs: [leg(1)],
          sellIxs: [leg(2)],
          payer: payer.publicKey,
          recentBlockhash: blockhash,
        }),
      /1232/,
    );
    const table = alt(extras);
    const { bytes, tx } = compileRoundTripForSim({
      buyIxs: [leg(1)],
      sellIxs: [leg(2)],
      payer: payer.publicKey,
      recentBlockhash: blockhash,
      lookupTables: [table, table],
    });
    assert.ok(bytes <= SIM_TX_SIZE_LIMIT);
    assert.equal(tx.message.addressTableLookups.length, 1);
  });

  it("still fails closed when the combined transaction cannot fit", () => {
    const payer = Keypair.generate();
    const extras = Array.from({ length: 45 }, () => Keypair.generate().publicKey);
    const ix = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: extras.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      data: Buffer.from([9]),
    });
    assert.throws(
      () =>
        compileRoundTripForSim({
          buyIxs: [ix],
          sellIxs: [ix],
          payer: payer.publicKey,
          recentBlockhash: Keypair.generate().publicKey.toBase58(),
          lookupTables: [alt([Keypair.generate().publicKey])],
        }),
      /1232/,
    );
    assert.equal(sellSimVerdict("sim_error", true).outcome, "failed");
    assert.equal(sellSimVerdict("sim_error", true).refuseBuy, true);
  });

  it("reads lookup tables only from the Jupiter swap-instructions body", () => {
    const fromJupiter = Keypair.generate().publicKey.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    const addrs = altAddressesFromSwapBodies([
      { swapInstruction: null, addressLookupTableAddresses: [fromJupiter, fromJupiter] },
      { swapInstruction: null, addressLookupTableAddresses: [other, fromJupiter] },
    ]);
    assert.deepEqual(addrs, [fromJupiter, other]);
    assert.deepEqual(ROUND_TRIP_ACCOUNT_CAPS, [undefined, 40, 30]);
  });
});

describe("Jupiter rate limit and API key header", () => {
  it("sends x-api-key when a key is configured and omits it when empty", async () => {
    const seen: Array<Record<string, string>> = [];
    const limiter = new JupiterLimiter(100);
    await jupiterFetch(
      "https://api.jup.ag/swap/v1/quote?amount=1",
      { method: "GET" },
      {
        apiKey: "unit-test-key",
        priority: "buy",
        limiter,
        fetchImpl: async (_url, init) => {
          seen.push(jupiterHeaders(undefined, init?.headers));
          return new Response("{}", { status: 200 });
        },
      },
    );
    assert.equal(seen[0]?.["x-api-key"], "unit-test-key");
    const empty = jupiterHeaders("");
    assert.equal(empty["x-api-key"], undefined);
  });

  it("honors Retry-After and otherwise backs off 1s, 2s, 4s", () => {
    assert.equal(rateLimitBackoffMs(0, "2", 0), 2000);
    assert.equal(rateLimitBackoffMs(0, null), 1000);
    assert.equal(rateLimitBackoffMs(1, null), 2000);
    assert.equal(rateLimitBackoffMs(2, null), 4000);
    assert.equal(rateLimitBackoffMs(6, null), 4000);
  });

  it("keeps a 429 on the same ladder rung, then moves on", () => {
    const error = "Jupiter /order 429: Too many requests";
    assert.equal(ladderStep({ ok: false, inFlight: false, error, rateAttempts: 0 }).toString(), "retry-same-rung");
    assert.equal(ladderStep({ ok: false, inFlight: false, error, rateAttempts: 1 }).toString(), "retry-same-rung");
    assert.equal(ladderStep({ ok: false, inFlight: false, error, rateAttempts: 2 }).toString(), "next-rung");
    assert.equal(
      ladderStep({ ok: false, inFlight: false, error: "slippage", rateAttempts: 0 }).toString(),
      "next-rung",
    );
  });

  it("serves a queued sell before a queued buy", async () => {
    const limiter = new JupiterLimiter(1, 0);
    const order: string[] = [];
    const buy = limiter.acquire("buy").then(() => order.push("buy"));
    const sell = limiter.acquire("sell").then(() => order.push("sell"));
    await Promise.resolve();
    limiter.releaseToken();
    await sell;
    assert.deepEqual(order, ["sell"]);
    limiter.releaseToken();
    await buy;
    assert.deepEqual(order, ["sell", "buy"]);
  });
});
