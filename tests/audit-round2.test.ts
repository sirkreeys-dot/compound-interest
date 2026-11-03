import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { parseAlert } from "../src/fomo/adapter.js";
import { validateJupiterOrder } from "../src/security/jupiterTx.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { redactSecrets } from "../src/security/redact.js";
import { resolveSellFraction } from "../src/engine/sellFraction.js";
import type { OpenPosition } from "../src/types.js";

const VALID_SOL = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-audit-r2");

function signedTxB64(ours: Keypair): string {
  const dest = Keypair.generate();
  const ix = SystemProgram.transfer({
    fromPubkey: ours.publicKey,
    toPubkey: dest.publicKey,
    lamports: 1,
  });
  const msg = new TransactionMessage({
    payerKey: ours.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ix],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

describe("audit-r2: synth eventId must be stable", () => {
  it("same alert without eventId yields identical ids across parses (no Date.now)", () => {
    const raw = {
      type: "alert",
      alertType: "buy",
      tradeId: "trade-stable-1",
      ts: 1700000000000,
      trader: "alpha",
      tokenAddress: VALID_SOL,
      chain: "solana",
    };
    const a = parseAlert(raw)!;
    const b = parseAlert(raw)!;
    assert.equal(a.eventId, b.eventId);
    assert.match(a.eventId, /^synth:trade-stable-1:1700000000000:/);
    assert.equal(a.eventId.includes(String(Date.now()).slice(0, 8)), false);
  });

  it("missing ts still stable (uses nots sentinel, not wall clock)", () => {
    const raw = {
      type: "alert",
      alertType: "sell",
      tradeId: "trade-2",
      trader: "alpha",
      tokenAddress: VALID_SOL,
      chain: "solana",
    };
    const a = parseAlert(raw)!;
    const b = parseAlert(raw)!;
    assert.equal(a.eventId, b.eventId);
    assert.match(a.eventId, /:nots:/);
  });
});

describe("audit-r2: Jupiter min-out / missing slippage gate", () => {
  it("refuses order with neither slippageBps nor otherAmountThreshold", () => {
    const ours = Keypair.generate();
    const r = validateJupiterOrder({
      order: {
        transaction: signedTxB64(ours),
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: VALID_SOL,
        inAmount: "1000",
        outAmount: "500",
      },
      expectedInputMint: "So11111111111111111111111111111111111111112",
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /missing slippageBps and otherAmountThreshold/);
  });

  it("refuses otherAmountThreshold that implies slippage above max", () => {
    const ours = Keypair.generate();
    // out=1000, minOut=500 → 5000 bps > 300
    const r = validateJupiterOrder({
      order: {
        transaction: signedTxB64(ours),
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: VALID_SOL,
        inAmount: "1000",
        outAmount: "1000",
        slippageBps: 100, // claim looks fine
        otherAmountThreshold: "500",
      },
      expectedInputMint: "So11111111111111111111111111111111111111112",
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /implied slippage/);
  });

  it("accepts otherAmountThreshold within maxSlippageBps when slippageBps omitted", () => {
    const ours = Keypair.generate();
    // out=10000, minOut=9700 → 300 bps exactly
    const r = validateJupiterOrder({
      order: {
        transaction: signedTxB64(ours),
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: VALID_SOL,
        inAmount: "1000",
        outAmount: "10000",
        otherAmountThreshold: "9700",
      },
      expectedInputMint: "So11111111111111111111111111111111111111112",
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(r.ok, true);
  });
});

describe("audit-r2: kill switch write-fail latch", () => {
  it("keeps entries paused if pause() cannot write the kill file", () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // Point at a path whose parent is a file → writeFileSync throws
    const blocker = path.join(tmp, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const kill = new KillSwitch(path.join(blocker, "kill.switch"));
    kill.pause("test-write-fail");
    assert.equal(kill.isPaused(), true, "latch must block entries after failed write");
    kill.resume();
    assert.equal(kill.isPaused(), false);
  });

  it("still allows resume-by-deleting-file on the happy path", () => {
    const dir = path.join(tmp, "happy");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "kill.switch");
    const kill = new KillSwitch(file);
    kill.pause("test");
    assert.equal(kill.isPaused(), true);
    fs.unlinkSync(file);
    assert.equal(kill.isPaused(), false, "disk remains source of truth when write succeeded");
  });
});

describe("audit-r2: redactSecrets still covers FOMO query keys", () => {
  it("redacts key= in urls", () => {
    const s = redactSecrets("wss://api.fomoapi.io/ws/alerts?key=SUPERSECRET&trader=x");
    assert.equal(s.includes("SUPERSECRET"), false);
  });
});

describe("audit-r2: sell fraction ignores cumulative sold/bought without entry snapshot", () => {
  it("does not use fomo_sold_vs_bought when traderTokenAmountAtEntry is null", async () => {
    const pos: OpenPosition = {
      id: "1",
      traderUserId: "u1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: VALID_SOL,
      tokenSymbol: "TOK",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 2,
      quantityRaw: "1000",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "e",
      status: "open",
      isDryRun: true,
    };
    const fomo = {
      positions: async () => ({
        positions: [
          {
            token: { address: VALID_SOL },
            status: "open",
            amount: 50,
            boughtAmount: 100,
            soldAmount: 90, // lifetime — would wrongly imply 90% sell
          },
        ],
      }),
    };
    const r = await resolveSellFraction({ pos, fomo: fomo as never });
    assert.notEqual(r.method, "fomo_sold_vs_bought");
    // Without reliable fraction → full exit fallback
    assert.equal(r.method, "full_exit_fallback");
    assert.equal(r.fraction, 1);
  });
});
