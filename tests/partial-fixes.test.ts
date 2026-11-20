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
import { loadAppConfig, type EnvConfig } from "../src/config.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import {
  classifyBaseSellSim,
  judgeBaseBalanceDiff,
  judgeBaseControls,
  baseHolderCheck,
  baseLiquidityUsd,
  nativeBalanceFromTrace,
} from "../src/security/baseChecks.js";
import { evaluateFakeLiquidity, evaluateQuoteDepth, jupiterImpactBps } from "../src/security/fakeLiquidity.js";
import { classifySellSimulation, combineBuyAndSellForSim } from "../src/security/sellSim.js";
import { inspectSolanaMint } from "../src/security/tokenSafety.js";
import { reconcilePendingSwaps } from "../src/store/reconcilePending.js";
import { Store } from "../src/store/db.js";
import { fetchRetry } from "../src/utils/http.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-partial");
const MINT = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function env(dir: string): EnvConfig {
  return {
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
  };
}

function openPos(store: Store, id: string, qty = "1000") {
  store.insertPosition({
    id,
    traderUserId: "uid-1",
    traderHandle: "alpha",
    tradeId: null,
    chain: "solana",
    tokenAddress: MINT,
    tokenSymbol: "T",
    entryUsd: 2,
    sizeUsd: 2,
    remainingUsd: 2,
    quantityRaw: qty,
    entryPriceUsd: null,
    traderSizeAtEntryUsd: null,
    traderTokenAmountAtEntry: null,
    openedAt: new Date().toISOString(),
    sourceEventId: id,
    status: "open",
    isDryRun: false,
  });
  assert.ok(store.claimPositionForClose(id));
}

describe("H5 crash recovery outcomes", () => {
  it("resolves buys and sells for confirmed, failed, expired, and unknown", async () => {
    const dir = path.join(tmp, "h5");
    fs.rmSync(dir, { recursive: true, force: true });
    const store = new Store(dir);
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    const tg = new TelegramNotifier("", "");
    const sigs: Record<string, { confirmationStatus?: string | null; err?: unknown } | null> = {
      buyOk: { confirmationStatus: "finalized", err: null },
      sellOk: { confirmationStatus: "confirmed", err: null },
      buyBad: { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } },
      sellBad: { err: { InstructionError: [1, "Custom"] } },
      buyExp: null,
      sellExp: null,
      buyUnk: null,
      sellUnk: null,
      buyRpc: null,
    };
    const heights: Record<string, boolean> = {
      buyExp: false,
      sellExp: false,
      buyUnk: true,
      sellUnk: true,
    };
    const rows: Array<[string, "buy" | "sell", string, string?]> = [
      ["buy-ok", "buy", "buyOk"],
      ["sell-ok", "sell", "sellOk", "pos-sell-ok"],
      ["buy-bad", "buy", "buyBad"],
      ["sell-bad", "sell", "sellBad", "pos-sell-bad"],
      ["buy-exp", "buy", "buyExp"],
      ["sell-exp", "sell", "sellExp", "pos-sell-exp"],
      ["buy-unk", "buy", "buyUnk"],
      ["sell-unk", "sell", "sellUnk", "pos-sell-unk"],
    ];
    for (const [id, side, sigKey, pos] of rows) {
      if (pos) openPos(store, pos);
      store.insertPendingSwap({
        id,
        chain: "solana",
        side,
        tokenAddress: MINT,
        sellToken: MINT,
        buyToken: side === "buy" ? MINT : "So11111111111111111111111111111111111111112",
        sizeUsd: 2,
        sourceEventId: id,
        traderUserId: "uid-1",
        traderHandle: "alpha",
        positionId: pos ?? null,
      });
      store.updatePendingSwap(id, {
        status: "broadcast",
        txSignature: sigKey,
        blockhash: `bh-${sigKey}`,
        lastValidBlockHeight: 100,
      });
    }

    const run = () =>
      reconcilePendingSwaps({
        store,
        env: env(dir),
        cfg,
        tg,
        rpcUrl: "http://127.0.0.1",
        getSignatureStatuses: async (sigsIn) => {
          const key = sigsIn[0]!;
          if (key === "buyRpc") throw new Error("rpc down");
          return [sigs[key] ?? null];
        },
        isBlockhashValid: async (bh) => heights[bh.replace("bh-", "")] ?? true,
        getWalletTokenAmount: async () => "100",
      });

    await run();
    assert.equal(store.getPendingSwap("buy-ok")!.status, "reconciled");
    assert.equal(store.getPosition(store.getPendingSwap("buy-ok")!.positionId!)!.quantityRaw, "100");
    assert.equal(store.getPendingSwap("sell-ok")!.status, "reconciled");
    assert.equal(store.getPosition("pos-sell-ok")!.quantityRaw, "100");
    assert.equal(store.getPosition("pos-sell-ok")!.status, "open");
    assert.equal(store.getPendingSwap("buy-bad")!.status, "failed");
    assert.equal(store.getPendingSwap("sell-bad")!.status, "failed");
    assert.equal(store.getPosition("pos-sell-bad")!.status, "open");
    assert.equal(store.getPendingSwap("buy-exp")!.status, "expired");
    assert.equal(store.getPendingSwap("sell-exp")!.status, "expired");
    assert.equal(store.getPosition("pos-sell-exp")!.status, "open");
    assert.equal(store.getPendingSwap("buy-unk")!.status, "unknown");
    assert.equal(store.getPendingSwap("sell-unk")!.status, "unknown");
    assert.equal(store.getPosition("pos-sell-unk")!.status, "closing");
    assert.equal(store.resetStuckClosing(), 0);

    const before = store.listOpen().length;
    await run();
    assert.equal(store.listOpen().length, before);
    assert.equal(store.listOpen().filter((p) => p.sourceEventId === "buy-ok").length, 1);

    store.insertPendingSwap({
      id: "buy-rpc",
      chain: "solana",
      side: "buy",
      tokenAddress: MINT,
      sourceEventId: "buy-rpc",
      sizeUsd: 2,
    });
    store.updatePendingSwap("buy-rpc", { status: "broadcast", txSignature: "buyRpc", blockhash: "bh-buyRpc" });
    await reconcilePendingSwaps({
      store,
      env: env(dir),
      cfg,
      tg,
      rpcUrl: "http://127.0.0.1",
      getSignatureStatuses: async () => {
        throw new Error("rpc down");
      },
      getWalletTokenAmount: async () => "100",
    });
    assert.equal(store.getPendingSwap("buy-rpc")!.status, "unknown");
    store.close();
  });
});

describe("H6 trap tokens", () => {
  it("classifies honeypot simulations separately from an empty wallet", () => {
    assert.equal(classifySellSimulation(null), "ok");
    assert.equal(classifySellSimulation({ InstructionError: [2, "Custom"] }, ["custom program error: 0x1"]), "no_balance");
    assert.equal(classifySellSimulation({ InstructionError: [2, { Custom: 30 }] }, ["custom program error: 0x1e"]), "honeypot");
  });

  it("builds one simulation transaction that runs the buy before the sell", () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const msg = (lamports: number) =>
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports })],
      }).compileToV0Message();
    const buy = new VersionedTransaction(msg(1));
    const sell = new VersionedTransaction(msg(2));
    const combined = combineBuyAndSellForSim({
      buy,
      sell,
      buyKeys: buy.message.staticAccountKeys,
      sellKeys: sell.message.staticAccountKeys,
      payer: payer.publicKey,
    });
    assert.equal(combined.message.compiledInstructions.length, 2);
    assert.equal(combined.message.staticAccountKeys[0]!.equals(payer.publicKey), true);
  });

  it("blocks young pools, empty quote reserves, deep-pool impact, hooks, and high fees", async () => {
    const now = 1_700_000_000_000;
    const young = evaluateFakeLiquidity({
      minLiquidityUsd: 10_000,
      minPairAgeSec: 1800,
      nowMs: now,
      fetchFailed: false,
      pair: { liquidityUsd: 50_000, pairCreatedAtMs: now - 60_000, quoteReserve: 10 },
    });
    assert.equal(young.blocked, true);
    const oneSided = evaluateFakeLiquidity({
      minLiquidityUsd: 10_000,
      minPairAgeSec: 0,
      nowMs: now,
      fetchFailed: false,
      pair: { liquidityUsd: 50_000, pairCreatedAtMs: now - 10_000_000, quoteReserve: 0 },
    });
    assert.match(oneSided.detail, /zero/);
    const depth = evaluateQuoteDepth({
      minLiquidityUsd: 10_000,
      liquidityUsd: 50_000,
      maxImpactBps: 1000,
      sellImpactBps: 1500,
    });
    assert.equal(depth.blocked, true);
    assert.equal(jupiterImpactBps("0.15"), 1500);

    const hook = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      getParsedAccountInfo: async () => ({
        owner: TOKEN_2022,
        parsed: {
          parsed: {
            type: "mint",
            info: {
              mintAuthority: null,
              freezeAuthority: null,
              supply: "100",
              extensions: [{ extension: "transferHook", state: {} }],
            },
          },
        },
      }),
    });
    assert.equal(hook.blockReason, "transfer_hook");
    const fee = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      maxTransferFeeBps: 100,
      getParsedAccountInfo: async () => ({
        owner: TOKEN_2022,
        parsed: {
          parsed: {
            type: "mint",
            info: {
              mintAuthority: null,
              freezeAuthority: null,
              supply: "100",
              extensions: [
                {
                  extension: "transferFeeConfig",
                  state: { newerTransferFee: { transferFeeBasisPoints: 250 } },
                },
              ],
            },
          },
        },
      }),
    });
    assert.equal(fee.blockReason, "transfer_fee");
    const delegate = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      getParsedAccountInfo: async () => ({
        owner: TOKEN_2022,
        parsed: {
          parsed: {
            type: "mint",
            info: {
              mintAuthority: null,
              freezeAuthority: null,
              supply: "100",
              extensions: [{ extension: "permanentDelegate", state: {} }],
            },
          },
        },
      }),
    });
    assert.equal(delegate.blockReason, "permanent_delegate");
  });
});

describe("M5 timeouts", () => {
  it("aborts a hung fetch and retries a 500 before succeeding", async () => {
    await assert.rejects(
      () =>
        fetchRetry(
          "https://example.test/slow",
          {},
          {
            timeoutMs: 30,
            retries: 0,
            fetchImpl: ((_url, init) =>
              new Promise((_resolve, reject) => {
                const signal = (init as RequestInit | undefined)?.signal;
                signal?.addEventListener("abort", () => reject(new Error("aborted")));
              })) as typeof fetch,
          },
        ),
      /aborted/,
    );
    let calls = 0;
    const res = await fetchRetry(
      "https://example.test/flaky",
      {},
      {
        timeoutMs: 200,
        retries: 2,
        fetchImpl: (async () => {
          calls++;
          if (calls < 3) return new Response("no", { status: 500 });
          return new Response("ok", { status: 200 });
        }) as typeof fetch,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  });
});

describe("M9 Base checks", () => {
  it("blocks owner, pause, blacklist, mint, missing holders, and a bad balance diff", () => {
    assert.equal(
      judgeBaseControls({
        owner: "0x0000000000000000000000000000000000000001",
        ownerCallFailed: false,
        paused: false,
        blacklisted: false,
        bytecode: "0x",
      }).blocked,
      true,
    );
    assert.match(
      judgeBaseControls({
        owner: "0x0000000000000000000000000000000000000000",
        ownerCallFailed: false,
        paused: true,
        blacklisted: false,
        bytecode: "0x",
      }).detail,
      /paused/,
    );
    assert.match(
      judgeBaseControls({
        owner: "0x0000000000000000000000000000000000000000",
        ownerCallFailed: false,
        paused: false,
        blacklisted: true,
        bytecode: "0x",
      }).detail,
      /blacklist/,
    );
    assert.match(
      judgeBaseControls({
        owner: "0x0000000000000000000000000000000000000001",
        ownerCallFailed: false,
        paused: false,
        blacklisted: false,
        bytecode: "0x40c10f19",
      }).detail,
      /mintable/,
    );
    assert.equal(baseHolderCheck(9000).blocked, true);
    assert.equal(baseHolderCheck(0).blocked, false);
    assert.equal(
      baseLiquidityUsd({
        pairs: [
          { chainId: "solana", quoteToken: { address: "So11111111111111111111111111111111111111112" }, liquidity: { usd: 99999 } },
          { chainId: "base", quoteToken: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, liquidity: { usd: 12000 } },
        ],
      }),
      12000,
    );
    assert.equal(classifyBaseSellSim({ reverted: true, revertText: "execution reverted", tokenBalance: 5n }), "honeypot");
    assert.equal(classifyBaseSellSim({ reverted: true, revertText: "exceeds balance", tokenBalance: 0n }), "no_balance");
    const bad = judgeBaseBalanceDiff({
      nativeBefore: 100n,
      nativeAfter: 10n,
      maxNativeDrop: 20n,
      tokens: [],
    });
    assert.equal(bad.ok, false);
    const traced = nativeBalanceFromTrace(
      { stateDiff: { "0xabc": { balance: { "*": { from: "0x10", to: "0x8" } } } } },
      "0xabc",
    );
    assert.equal(traced?.before, 16n);
    assert.equal(traced?.after, 8n);
  });
});
