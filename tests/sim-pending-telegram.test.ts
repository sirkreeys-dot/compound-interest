import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import {
  evaluateSimulatedBalances,
  parseSplTokenAmount,
  deriveAta,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../src/security/simulateSwap.js";
import { Store } from "../src/store/db.js";
import { reconcilePendingSwaps } from "../src/store/reconcilePending.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { loadAppConfig } from "../src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-sim-pending");

describe("sim: parseSplTokenAmount / deriveAta", () => {
  it("reads u64 LE amount at offset 64", () => {
    const buf = Buffer.alloc(165, 0);
    buf.writeBigUInt64LE(123456789n, 64);
    assert.equal(parseSplTokenAmount(buf.toString("base64")), 123456789n);
  });

  it("deriveAta is deterministic", () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    assert.equal(
      deriveAta(owner, mint, TOKEN_PROGRAM_ID).toBase58(),
      deriveAta(owner, mint, TOKEN_PROGRAM_ID).toBase58(),
    );
  });
});

describe("sim: evaluateSimulatedBalances", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const inputAta = Keypair.generate().publicKey.toBase58();
  const outputAta = Keypair.generate().publicKey.toBase58();
  const otherAta = Keypair.generate().publicKey.toBase58();
  const outMint = Keypair.generate().publicKey.toBase58();

  it("refuses SOL outflow above expected+tol for native in", () => {
    const preLamports = new Map([[wallet, 10_000_000]]);
    const r = evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: WSOL_MINT,
      outputMint: outMint,
      expectedInAmount: 1_000_000n,
      otherAmountThreshold: 1n,
      maxExtraLamports: 50_000,
      maxExtraTokenOutflow: 0n,
      pre: { lamports: preLamports, tokenAmounts: new Map(), tokenMints: new Map() },
      watchedAddresses: [wallet, outputAta],
      postAccounts: [
        { address: wallet, lamports: 10_000_000 - 2_000_000, dataBase64: null }, // drop 2e6 > 1e6+50k
        { address: outputAta, lamports: 0, dataBase64: null },
      ],
      inputTokenAccount: null,
      outputTokenAccount: outputAta,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /SOL outflow/);
  });

  it("refuses when output gain below otherAmountThreshold", () => {
    // Build fake token account data with amount
    function tokData(amount: bigint): string {
      const buf = Buffer.alloc(165, 0);
      buf.writeBigUInt64LE(amount, 64);
      return buf.toString("base64");
    }
    const pre = {
      lamports: new Map([[wallet, 5_000_000]]),
      tokenAmounts: new Map([
        [inputAta, 1_000_000n],
        [outputAta, 0n],
      ]),
      tokenMints: new Map([
        [inputAta, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
        [outputAta, outMint],
      ]),
    };
    const r = evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: outMint,
      expectedInAmount: 1_000_000n,
      otherAmountThreshold: 500n,
      maxExtraLamports: 50_000,
      maxExtraTokenOutflow: 0n,
      pre,
      watchedAddresses: [wallet, inputAta, outputAta],
      postAccounts: [
        { address: wallet, lamports: 4_980_000, dataBase64: null },
        { address: inputAta, lamports: 0, dataBase64: tokData(0n) },
        { address: outputAta, lamports: 0, dataBase64: tokData(100n) }, // gain 100 < 500
      ],
      inputTokenAccount: inputAta,
      outputTokenAccount: outputAta,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /otherAmountThreshold/);
  });

  it("refuses drain of unrelated wallet token account", () => {
    function tokData(amount: bigint): string {
      const buf = Buffer.alloc(165, 0);
      buf.writeBigUInt64LE(amount, 64);
      return buf.toString("base64");
    }
    const otherMint = Keypair.generate().publicKey.toBase58();
    const pre = {
      lamports: new Map([[wallet, 5_000_000]]),
      tokenAmounts: new Map([
        [inputAta, 1_000_000n],
        [outputAta, 0n],
        [otherAta, 999n],
      ]),
      tokenMints: new Map([
        [inputAta, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
        [outputAta, outMint],
        [otherAta, otherMint],
      ]),
    };
    const r = evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: outMint,
      expectedInAmount: 1_000_000n,
      otherAmountThreshold: 10n,
      maxExtraLamports: 50_000,
      maxExtraTokenOutflow: 0n,
      pre,
      watchedAddresses: [wallet, inputAta, outputAta, otherAta],
      postAccounts: [
        { address: wallet, lamports: 4_980_000, dataBase64: null },
        { address: inputAta, lamports: 0, dataBase64: tokData(0n) },
        { address: outputAta, lamports: 0, dataBase64: tokData(50n) },
        { address: otherAta, lamports: 0, dataBase64: tokData(1n) }, // drained
      ],
      inputTokenAccount: inputAta,
      outputTokenAccount: outputAta,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /unexpected drain/);
  });

  it("accepts a clean USDC→token swap within tolerances", () => {
    function tokData(amount: bigint): string {
      const buf = Buffer.alloc(165, 0);
      buf.writeBigUInt64LE(amount, 64);
      return buf.toString("base64");
    }
    const pre = {
      lamports: new Map([[wallet, 5_000_000]]),
      tokenAmounts: new Map([
        [inputAta, 1_000_000n],
        [outputAta, 0n],
      ]),
      tokenMints: new Map([
        [inputAta, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
        [outputAta, outMint],
      ]),
    };
    const r = evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: outMint,
      expectedInAmount: 1_000_000n,
      otherAmountThreshold: 40n,
      maxExtraLamports: 50_000,
      maxExtraTokenOutflow: 0n,
      pre,
      watchedAddresses: [wallet, inputAta, outputAta],
      postAccounts: [
        { address: wallet, lamports: 4_980_000, dataBase64: null },
        { address: inputAta, lamports: 0, dataBase64: tokData(0n) },
        { address: outputAta, lamports: 0, dataBase64: tokData(50n) },
      ],
      inputTokenAccount: inputAta,
      outputTokenAccount: outputAta,
    });
    assert.equal(r.ok, true);
  });
});

describe("pending ledger + reconcile", () => {
  it("insert/update/reconcile happy path", () => {
    const dir = path.join(tmp, "ledger");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    store.insertPendingSwap({
      id: "p1",
      chain: "solana",
      side: "buy",
      sourceEventId: "ev1",
      tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
      sizeUsd: 2,
      expectedOutRaw: "1000",
    });
    let row = store.getPendingSwap("p1")!;
    assert.equal(row.status, "pending_broadcast");
    store.updatePendingSwap("p1", { status: "confirmed", txSignature: "sig111" });
    row = store.getPendingSwap("p1")!;
    assert.equal(row.status, "confirmed");
    assert.equal(row.txSignature, "sig111");
    store.markPendingReconciled("p1", "pos1");
    assert.equal(store.getPendingSwap("p1")!.status, "reconciled");
    assert.equal(store.listUnresolvedPending().length, 0);
    store.close();
  });

  it("startup reconcile marks never-broadcast as failed; recovers confirmed into position", async () => {
    const dir = path.join(tmp, "reconcile");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    const tg = new TelegramNotifier("", "");
    store.insertPendingSwap({
      id: "abandoned",
      chain: "solana",
      side: "buy",
      tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
      sizeUsd: 2,
    });
    store.insertPendingSwap({
      id: "need-recover",
      chain: "solana",
      side: "buy",
      sourceEventId: "ev-recover",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
      sizeUsd: 2,
      expectedOutRaw: "4242",
    });
    store.updatePendingSwap("need-recover", {
      status: "confirmed",
      txSignature: "SigRecover111111111111111111111111111111111111",
    });

    const result = await reconcilePendingSwaps({
      store,
      env: {
        fomoApiKey: "",
        dryRun: true,
        solanaRpcUrl: "http://127.0.0.1",
        solanaPrivateKey: "",
        jupiterApiKey: "",
        baseRpcUrl: "",
        basePrivateKey: "",
        zeroXApiKey: "",
        telegramBotToken: "",
        telegramChatId: "",
        telegramAllowedUserIds: [],
        configPath: "",
        dataDir: dir,
        killSwitchPath: path.join(dir, "k"),
      },
      cfg,
      tg,
      rpcUrl: "http://127.0.0.1",
      getSignatureStatuses: async () => [
        { confirmationStatus: "finalized", err: null },
      ],
    });
    // abandoned resolved as failed; need-recover resolved into position
    assert.ok(result.resolved >= 1);
    assert.equal(store.getPendingSwap("abandoned")!.status, "failed");
    assert.equal(store.getPendingSwap("need-recover")!.status, "reconciled");
    const opens = store.listOpen();
    assert.equal(opens.length, 1);
    assert.equal(opens[0]!.quantityRaw, "4242");
    store.close();
  });
});

describe("telegram TELEGRAM_ALLOWED_USER_IDS lock", () => {
  it("rejects command from wrong from.id even in allowed chat", async () => {
    const dir = path.join(tmp, "tg-user");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tg = new TelegramNotifier("token", "111", ["999"]); // only user 999
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
          result: [
            {
              update_id: 1,
              message: {
                chat: { id: 111 },
                from: { id: 222 }, // wrong user
                text: "/pause",
              },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), false);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 2,
              edited_message: {
                chat: { id: 111 },
                from: { id: 999 },
                text: "/pause",
              },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), true);
    globalThis.fetch = original;
    store.close();
  });

  it("when allow-list empty, chat id alone still authorizes (back-compat)", async () => {
    const dir = path.join(tmp, "tg-compat");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tg = new TelegramNotifier("token", "111", []); // no user lock
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
          result: [
            {
              update_id: 3,
              message: { chat: { id: 111 }, from: { id: 1 }, text: "/pause" },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), true);
    globalThis.fetch = original;
    store.close();
  });
});

describe("config: simulateBeforeSign defaults", () => {
  it("config.example.yaml loads simulateBeforeSign true", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    assert.equal(cfg.risk.simulateBeforeSign, true);
    assert.equal(cfg.risk.simMaxExtraLamports, 50_000);
    assert.equal(cfg.risk.simMaxExtraTokenOutflow, 0);
  });
});
