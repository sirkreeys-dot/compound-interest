import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig, loadEnv } from "../src/config.js";
import { evaluateAlert } from "../src/engine/filters.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { ExecutionRouter } from "../src/execution/index.js";
import { Store } from "../src/store/db.js";
import type { AppConfig, NormalizedAlert } from "../src/types.js";
import type { EnvConfig } from "../src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function baseAlert(over: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    eventId: "ch-" + Math.random().toString(16).slice(2),
    alertType: "buy",
    source: "feed",
    userId: "uid-1",
    tradeId: null,
    swapId: null,
    traderHandle: "alpha",
    tokenSymbol: "TOK",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chain: "base",
    chainId: 8453,
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

describe("Solana-only defaults", () => {
  it("config.example.yaml defaults: base off, allowedChains solana only", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    assert.equal(cfg.chains.solana, true);
    assert.equal(cfg.chains.base, false);
    assert.deepEqual(cfg.filters.allowedChains, ["solana"]);
  });

  it("ENABLED_CHAINS=solana overrides yaml that had base on", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"), {
      ...loadEnv(),
      enabledChains: ["solana"],
    });
    assert.equal(cfg.chains.base, false);
    assert.deepEqual(cfg.filters.allowedChains, ["solana"]);
  });

  it("startup ExecutionRouter without Base/0x vars succeeds when base disabled", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    assert.equal(cfg.chains.base, false);
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: true,
      solanaRpcUrl: "https://api.mainnet-beta.solana.com",
      solanaPrivateKey: "",
      jupiterApiKey: "",
      baseRpcUrl: "",
      basePrivateKey: "",
      zeroXApiKey: "",
      telegramBotToken: "",
      telegramChatId: "",
      configPath: path.join(root, "config.example.yaml"),
      dataDir: path.join(root, "data", "test-chains"),
      killSwitchPath: path.join(root, "data", "test-chains", "kill.switch"),
      telegramAllowedUserIds: [],
    };
    fs.mkdirSync(env.dataDir, { recursive: true });
    const exec = new ExecutionRouter(env, cfg);
    assert.equal(exec.base, null);
    assert.ok(exec.solana);
  });

  it("Base alert is skipped with clear reason; Solana alert can still pass filters", async () => {
    const dir = path.join(root, "data", "test-chains-filter");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [
      { handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana", "base"] },
    ];
    cfg.sizing.minTraderTradeUsd = 0;
    cfg.risk.cooldownSeconds = 0;
    const store = new Store(dir);
    const watchlist = new Watchlist(cfg, null, undefined, store);
    await watchlist.start();

    const baseSkip = evaluateAlert(baseAlert({ eventId: "base-1" }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(baseSkip.ok, false);
    assert.equal(baseSkip.reason, "unsupported_chain");
    assert.match(baseSkip.detail ?? "", /base disabled/i);

    const solOk = evaluateAlert(
      baseAlert({
        eventId: "sol-1",
        chain: "solana",
        chainId: 1399811149,
        tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
      }),
      { cfg, store, dryRun: true, paused: false, watchlist },
    );
    assert.equal(solOk.ok, true);
    store.close();
  });

  it("buy on Base returns disabled error without constructing Base executor path", async () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: true,
      solanaRpcUrl: "https://api.mainnet-beta.solana.com",
      solanaPrivateKey: "",
      jupiterApiKey: "",
      baseRpcUrl: "",
      basePrivateKey: "",
      zeroXApiKey: "",
      telegramBotToken: "",
      telegramChatId: "",
      configPath: "",
      dataDir: path.join(root, "data", "test-chains2"),
      killSwitchPath: path.join(root, "data", "test-chains2", "k"),
      telegramAllowedUserIds: [],
    };
    fs.mkdirSync(env.dataDir, { recursive: true });
    const exec = new ExecutionRouter(env, cfg);
    const r = await exec.buy("base", {
      sellToken: "",
      buyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sellUsd: 2,
      slippageBps: 100,
      dryRun: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /base disabled/i);
  });
});
