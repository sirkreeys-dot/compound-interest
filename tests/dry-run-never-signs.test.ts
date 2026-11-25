import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { loadAppConfig, type EnvConfig } from "../src/config.js";
import { CopyEngine } from "../src/engine/copy.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { ExecutionRouter } from "../src/execution/index.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { Store } from "../src/store/db.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { scaleRawAmount } from "../src/utils/money.js";
import type { NormalizedAlert } from "../src/types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINT = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";
const SOL = "So11111111111111111111111111111111111111112";

function alert(over: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    eventId: "dry-" + Math.random().toString(16).slice(2),
    alertType: "buy",
    source: "feed",
    userId: "uid-1",
    tradeId: "trade-" + Math.random().toString(16).slice(2),
    swapId: null,
    traderHandle: "alpha",
    tokenSymbol: "TOK",
    tokenAddress: MINT,
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

describe("dry-run never signs or sends", () => {
  it("buy, mirror sell, stop-loss, and write-off stay paper", async () => {
    const sign = VersionedTransaction.prototype.sign;
    const sendRaw = Connection.prototype.sendRawTransaction;
    let signed = 0;
    let sent = 0;
    VersionedTransaction.prototype.sign = function () {
      signed++;
      throw new Error("SIGN CALLED");
    };
    Connection.prototype.sendRawTransaction = function () {
      sent++;
      throw new Error("SEND RAW CALLED");
    } as typeof sendRaw;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/execute") || url.includes("sendTransaction")) {
        signed++;
        throw new Error("EXECUTE CALLED");
      }
      if (url.includes("api.jup.ag/price/v3")) {
        return new Response(
          JSON.stringify({ [SOL]: { usdPrice: 100, blockId: 1, decimals: 9 } }),
          { status: 200 },
        );
      }
      if (url.includes("coingecko")) {
        return new Response(JSON.stringify({ solana: { usd: 100 } }), { status: 200 });
      }
      if (url.includes("/swap/v2/order")) {
        const u = new URL(url);
        const inMint = u.searchParams.get("inputMint");
        const amt = u.searchParams.get("amount") ?? "20000000";
        const sellingToken = inMint === MINT;
        return new Response(
          JSON.stringify({
            inputMint: inMint,
            outputMint: u.searchParams.get("outputMint"),
            inAmount: amt,
            outAmount: sellingToken ? "19000000" : "1000000",
            otherAmountThreshold: sellingToken ? "18000000" : "970000",
            inUsdValue: sellingToken ? 1.9 : 2,
            outUsdValue: sellingToken ? 1.9 : 2,
            slippageBps: 300,
            signatureFeeLamports: 5000,
            prioritizationFeeLamports: 1000,
            rentFeeLamports: 2_039_280,
            transaction: null,
            requestId: "dry-request",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const dir = path.join(root, "data", "test-dry-nosign");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [{ handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana"] }];
    cfg.sizing.minTraderTradeUsd = 0;
    cfg.risk.cooldownSeconds = 0;
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: true,
      solanaRpcUrl: "http://127.0.0.1:1",
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
    const store = new Store(dir);
    const watchlist = new Watchlist(cfg, null, undefined, store);
    await watchlist.start();
    const exec = new ExecutionRouter(env, cfg, undefined, store);
    const engine = new CopyEngine(
      env,
      cfg,
      store,
      exec,
      new KillSwitch(env.killSwitchPath),
      new TelegramNotifier("", ""),
      watchlist,
    );
    try {
      const refused = await exec.buy("solana", {
        sellToken: SOL,
        buyToken: MINT,
        sellUsd: 2,
        slippageBps: 300,
        dryRun: true,
      });
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? "", /token_safety: inspect_failed/);
      assert.match(refused.error ?? "", /mint inspection unavailable \(fail closed\)/);
      await engine.handleAlert(alert({ eventId: "buy-1", tradeId: "buy-1" }));
      assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
      store.insertPosition({
        id: "paper-1",
        traderUserId: "uid-1",
        traderHandle: "alpha",
        tradeId: "buy-1",
        chain: "solana",
        tokenAddress: MINT,
        tokenSymbol: "TOK",
        entryUsd: 2,
        sizeUsd: 2,
        remainingUsd: 2,
        quantityRaw: "1000",
        entryPriceUsd: null,
        traderSizeAtEntryUsd: 1000,
        traderTokenAmountAtEntry: null,
        openedAt: new Date().toISOString(),
        sourceEventId: "buy-1",
        status: "dry_open",
        isDryRun: true,
      });
      await engine.handleAlert(
        alert({ eventId: "sell-1", tradeId: "sell-1", alertType: "sell", tradeUsd: 1000 }),
      );
      assert.equal(store.getPosition("paper-1")?.status, "dry_closed");
      store.insertPosition({
        id: "paper-sl",
        traderUserId: "uid-1",
        traderHandle: "alpha",
        tradeId: "sl-1",
        chain: "solana",
        tokenAddress: MINT,
        tokenSymbol: "TOK",
        entryUsd: 2,
        sizeUsd: 2,
        remainingUsd: 2,
        quantityRaw: "1000",
        entryPriceUsd: null,
        traderSizeAtEntryUsd: 1000,
        traderTokenAmountAtEntry: null,
        openedAt: new Date().toISOString(),
        sourceEventId: "sl-1",
        status: "dry_open",
        isDryRun: true,
      });
      await engine.closePosition(store.getPosition("paper-sl")!, "stop_loss");
      assert.equal(store.getPosition("paper-sl")?.status, "dry_closed");
      store.insertPosition({
        id: "paper-2",
        traderUserId: "uid-1",
        traderHandle: "alpha",
        tradeId: "buy-2",
        chain: "solana",
        tokenAddress: MINT,
        tokenSymbol: "TOK",
        entryUsd: 2,
        sizeUsd: 2,
        remainingUsd: 2,
        quantityRaw: "1000",
        entryPriceUsd: null,
        traderSizeAtEntryUsd: 1000,
        traderTokenAmountAtEntry: null,
        openedAt: new Date().toISOString(),
        sourceEventId: "buy-2",
        status: "dry_open",
        isDryRun: true,
      });
      const wrote = await engine.writeOffToken(MINT);
      assert.match(wrote, /Wrote off/);
      assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
      assert.equal(signed, 0);
      assert.equal(sent, 0);
      assert.equal(store.getDaily().spentUsd, 0);
    } finally {
      VersionedTransaction.prototype.sign = sign;
      Connection.prototype.sendRawTransaction = sendRaw;
      globalThis.fetch = originalFetch;
      store.close();
    }
  });

  it("never sells more raw than the position holds", () => {
    assert.equal(scaleRawAmount("1000", 0.5), "500");
    assert.equal(scaleRawAmount("1", 0.5), "0");
    assert.equal(scaleRawAmount("1", 1), "1");
    const raw = "999999999999999999";
    assert.equal(BigInt(scaleRawAmount(raw, 0.5)) <= BigInt(raw), true);
  });
});

describe("committed config has no secrets and local yaml wins", () => {
  it("example defaults and gitignore", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    assert.equal(cfg.sizing.fixedUsd, 2);
    assert.equal(cfg.sizing.maxUsdPerTrade, 5);
    assert.equal(cfg.risk.dailyBudgetUsd, 40);
    assert.equal(cfg.risk.dailyLossLimitUsd, 20);
    assert.equal(cfg.risk.simMaxOverheadLamports, 5_000_000);
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /^config\.yaml$/m);
    const files = ["config.example.yaml", ".env.example", "fixtures/sample-alerts.json"];
    const secret = /fapi_[A-Za-z0-9]{8,}|alchemy\.com\/v2\/[A-Za-z0-9]{8,}|bot\d+:[A-Za-z0-9_-]{20,}/;
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      assert.equal(secret.test(text), false, file);
    }
  });

  it("a local overlay keeps omitted safety keys and accepts fixedUsd 1", () => {
    const dir = path.join(root, "data", "test-local-cfg");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "only-size.yaml");
    fs.writeFileSync(file, "sizing:\n  fixedUsd: 1\n");
    const dry = loadAppConfig(file);
    assert.equal(dry.sizing.fixedUsd, 1);
    assert.equal(dry.filters.minLiquidityUsd, 10_000);
    assert.equal(dry.filters.maxTopHolderBps, 9000);
    assert.equal(dry.filters.roundTripMaxLossBps, 2500);
    assert.equal(dry.filters.tokenSafety, "block");
    assert.equal(dry.risk.simulateBeforeSign, true);
    assert.equal(dry.risk.stopLossPct, 25);
    const live = loadAppConfig(file, { ...dryEnv(), dryRun: false });
    assert.equal(live.sizing.fixedUsd, 1);
    assert.equal(live.sizing.maxUsdPerTrade, 5);
  });

  it("live refuses a zeroed liquidity floor or a disabled or loosened holder cap", () => {
    const dir = path.join(root, "data", "test-local-cfg");
    fs.mkdirSync(dir, { recursive: true });
    const base = fs.readFileSync(path.join(root, "config.example.yaml"), "utf8");
    const live = { ...dryEnv(), dryRun: false };
    const cases: Array<[string, string]> = [
      ["liq.yaml", base.replace("minLiquidityUsd: 10000", "minLiquidityUsd: 0")],
      ["holder0.yaml", base.replace("maxTopHolderBps: 9000", "maxTopHolderBps: 0")],
      ["holder10000.yaml", base.replace("maxTopHolderBps: 9000", "maxTopHolderBps: 10000")],
    ];
    for (const [name, yaml] of cases) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, yaml);
      assert.throws(() => loadAppConfig(file, live), /LIVE refused/);
      const paper = loadAppConfig(file, dryEnv());
      assert.equal(paper.sizing.fixedUsd, 2);
    }
  });
});

function dryEnv(): EnvConfig {
  return {
    fomoApiKey: "",
    dryRun: true,
    solanaRpcUrl: "http://127.0.0.1:1",
    solanaPrivateKey: "",
    jupiterApiKey: "",
    baseRpcUrl: "",
    basePrivateKey: "",
    zeroXApiKey: "",
    telegramBotToken: "",
    telegramChatId: "",
    telegramAllowedUserIds: [],
    configPath: "",
    dataDir: path.join(root, "data", "test-floor-env"),
    killSwitchPath: path.join(root, "data", "test-floor-env", "k"),
  };
}
