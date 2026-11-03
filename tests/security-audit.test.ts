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
import { isValidSolanaAddress, isValidEvmAddress, isValidTokenAddress } from "../src/security/addresses.js";
import { validateJupiterOrder, validateVersionedTxFeePayer } from "../src/security/jupiterTx.js";
import { validateZeroXQuote, ZEROX_ALLOWANCE_HOLDER_CANCUN } from "../src/security/zeroxTx.js";
import { redactSecrets } from "../src/security/redact.js";
import { escapeHtml } from "../src/notify/telegram.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { Store } from "../src/store/db.js";
import { loadAppConfig } from "../src/config.js";
import { evaluateAlert } from "../src/engine/filters.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { FomoRestClient } from "../src/fomo/client.js";
import type { NormalizedAlert } from "../src/types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-security");
const VALID_SOL = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";

function alert(over: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    eventId: "ev-" + Math.random().toString(16).slice(2),
    alertType: "buy",
    source: "feed",
    userId: "uid-1",
    tradeId: "t1",
    swapId: null,
    traderHandle: "alpha",
    tokenSymbol: "TOK",
    tokenAddress: VALID_SOL,
    chain: "solana",
    chainId: 1399811149,
    tradeUsd: 1000,
    usdValue: 1000,
    positionValueUsd: 1000,
    text: null,
    ts: Date.now(),
    txHash: null,
    marketCapUsd: null,
    raw: {},
    ...over,
  };
}

describe("security: address validation", () => {
  it("accepts real Solana pubkeys and rejects junk", () => {
    assert.equal(isValidSolanaAddress(VALID_SOL), true);
    assert.equal(isValidSolanaAddress("So11111111111111111111111111111111111111112"), true);
    assert.equal(isValidSolanaAddress("not-a-mint"), false);
    assert.equal(isValidSolanaAddress("TokenMint1111111111111111111111111111111"), false);
  });
  it("accepts EVM addresses", () => {
    assert.equal(isValidEvmAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), true);
    assert.equal(isValidEvmAddress("0x1"), false);
    assert.equal(isValidTokenAddress("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), true);
  });
});

describe("security: Jupiter tx fee-payer gate", () => {
  it("refuses wrong fee payer", () => {
    const ours = Keypair.generate();
    const attacker = Keypair.generate();
    const dest = Keypair.generate();
    const ix = SystemProgram.transfer({
      fromPubkey: attacker.publicKey,
      toPubkey: dest.publicKey,
      lamports: 1,
    });
    const msg = new TransactionMessage({
      payerKey: attacker.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const r = validateVersionedTxFeePayer(tx, ours.publicKey);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /fee payer/);
  });

  it("accepts our fee payer and matching order fields", () => {
    const ours = Keypair.generate();
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
    const tx = new VersionedTransaction(msg);
    const b64 = Buffer.from(tx.serialize()).toString("base64");
    const input = "So11111111111111111111111111111111111111112";
    const output = VALID_SOL;
    const r = validateJupiterOrder({
      order: {
        transaction: b64,
        inputMint: input,
        outputMint: output,
        inAmount: "1000",
        outAmount: "500",
        slippageBps: 100,
        taker: ours.publicKey.toBase58(),
      },
      expectedInputMint: input,
      expectedOutputMint: output,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(r.ok, true);
  });

  it("rejects mint / amount / slippage mismatches", () => {
    const ours = Keypair.generate();
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
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
    const base = {
      transaction: b64,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: VALID_SOL,
      inAmount: "1000",
      outAmount: "500",
      slippageBps: 100,
    };
    const mintBad = validateJupiterOrder({
      order: { ...base, outputMint: "So11111111111111111111111111111111111111112" },
      expectedInputMint: base.inputMint,
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(mintBad.ok, false);
    const amtBad = validateJupiterOrder({
      order: { ...base, inAmount: "999" },
      expectedInputMint: base.inputMint,
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(amtBad.ok, false);
    const slipBad = validateJupiterOrder({
      order: { ...base, slippageBps: 9999 },
      expectedInputMint: base.inputMint,
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
    });
    assert.equal(slipBad.ok, false);
  });

  it("enforces maxChaseBps on order outUsd", () => {
    const ours = Keypair.generate();
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
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
    const r = validateJupiterOrder({
      order: {
        transaction: b64,
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: VALID_SOL,
        inAmount: "1000",
        outAmount: "500",
        slippageBps: 100,
      },
      expectedInputMint: "So11111111111111111111111111111111111111112",
      expectedOutputMint: VALID_SOL,
      expectedInAmount: "1000",
      maxSlippageBps: 300,
      ourPubkey: ours.publicKey,
      sellUsd: 2,
      outUsd: 1.5, // 25% loss = 2500 bps
      maxChaseBps: 500,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /chase_limit/);
  });
});

describe("security: 0x allowlist", () => {
  it("refuses arbitrary tx.to", () => {
    const r = validateZeroXQuote({
      quote: {
        buyAmount: "1",
        sellAmount: "1000",
        sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        buyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        transaction: {
          to: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
          data: "0x1234",
          value: "1000",
        },
      },
      expectedSellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      expectedBuyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      expectedSellAmount: "1000",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /AllowanceHolder/);
  });

  it("accepts AllowanceHolder with matching native value", () => {
    const r = validateZeroXQuote({
      quote: {
        buyAmount: "1",
        sellAmount: "1000",
        sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        buyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        transaction: {
          to: ZEROX_ALLOWANCE_HOLDER_CANCUN,
          data: "0xabcdef",
          value: "1000",
        },
      },
      expectedSellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      expectedBuyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      expectedSellAmount: "1000",
    });
    assert.equal(r.ok, true);
  });
});

describe("security: redactSecrets", () => {
  it("strips FOMO key, Telegram bot token, Bearer", () => {
    const s = redactSecrets(
      "wss://api.fomoapi.io/ws/alerts?key=secretKEY123&trader=x bot123456:AA-secret_token Bearer abc.def.ghi",
    );
    assert.equal(s.includes("secretKEY123"), false);
    assert.equal(s.includes("AA-secret_token"), false);
    assert.equal(s.includes("abc.def.ghi"), false);
    assert.match(s, /\[REDACTED\]/);
  });
});

describe("security: Telegram HTML escape + auth", () => {
  it("escapes angle brackets in token symbols", () => {
    assert.equal(escapeHtml("<b>evil</b>"), "&lt;b&gt;evil&lt;/b&gt;");
  });

  it("ignores edited_message from wrong chat; accepts from expected", async () => {
    const dir = path.join(tmp, "tg-edit");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tg = new TelegramNotifier("token", "111");
    const kill = new KillSwitch(path.join(dir, "kill.switch"));
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [{ handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana"] }];
    const store = new Store(dir);
    tg.attach({ store, kill, cfg, dryRun: true, getWsStatus: () => "ok" });

    const original = globalThis.fetch;
    let step = 0;
    globalThis.fetch = (async () => {
      step++;
      if (step === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 10,
                edited_message: { chat: { id: 999 }, text: "/pause" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      // authorized edited_message
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 11,
              edited_message: { chat: { id: 111 }, text: "/pause" },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), false);
    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), true);
    globalThis.fetch = original;
    store.close();
  });

  it("compares chat id number vs string env", async () => {
    const dir = path.join(tmp, "tg-num");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tg = new TelegramNotifier("token", "222"); // string
    const kill = new KillSwitch(path.join(dir, "kill.switch"));
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [{ handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana"] }];
    const store = new Store(dir);
    tg.attach({ store, kill, cfg, dryRun: true, getWsStatus: () => "ok" });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: [{ update_id: 1, message: { chat: { id: 222 }, text: "/pause" } }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), true);
    globalThis.fetch = original;
    store.close();
  });
});

describe("security: filter rejects invalid mint", () => {
  it("invalid_token_address for garbage mint", async () => {
    const dir = path.join(tmp, "mint");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [{ handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana"] }];
    const store = new Store(dir);
    const wl = new Watchlist(cfg, null, undefined, store);
    await wl.start();
    const r = evaluateAlert(alert({ tokenAddress: "not-valid!!!" }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist: wl,
    });
    assert.equal(r.reason, "invalid_token_address");
    store.close();
  });
});

describe("security: FOMO REST SSRF guard", () => {
  it("refuses non-allowlisted absolute URLs", async () => {
    const c = new FomoRestClient("k");
    await assert.rejects(
      () => c.getJson("https://evil.example/steal"),
      /allowlisted/,
    );
    await assert.rejects(
      () => c.getJson("http://api.fomoapi.io/v2/me"),
      /allowlisted/,
    );
  });
});

describe("security: zip / gitignore secrets", () => {
  it(".gitignore covers .env data kill.switch", () => {
    const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.match(gi, /^\.env$/m);
    assert.match(gi, /^data\//m);
    assert.match(gi, /^kill\.switch$/m);
  });
});
