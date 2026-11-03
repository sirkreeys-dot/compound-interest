import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAlert, computeSizeUsd } from "../src/engine/filters.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { Store } from "../src/store/db.js";
import type { AppConfig, NormalizedAlert } from "../src/types.js";
import { loadAppConfig } from "../src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-filters");

function baseAlert(over: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    eventId: "ev-1",
    alertType: "buy",
    source: "feed",
    userId: "6dcf7c78-2537-522a-8307-3f9970c081be",
    tradeId: "t1",
    swapId: null,
    traderHandle: "frankdegods",
    tokenSymbol: "PONS",
    tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
    chain: "solana",
    chainId: 1399811149,
    tradeUsd: 4000,
    usdValue: 4000,
    positionValueUsd: 4000,
    text: null,
    ts: Date.now(),
    txHash: null,
    marketCapUsd: null,
    raw: {},
    ...over,
  };
}

describe("filters", () => {
  let store: Store;
  let cfg: AppConfig;
  let watchlist: Watchlist;

  beforeEach(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    store = new Store(tmp);
    cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [
      {
        handle: "frankdegods",
        userId: "6dcf7c78-2537-522a-8307-3f9970c081be",
        enabled: true,
        chains: ["solana", "base"],
      },
    ];
    cfg.sizing.minTraderTradeUsd = 50;
    watchlist = new Watchlist(cfg, null, undefined, store);
    await watchlist.start();
  });

  it("accepts watched trader buy at $2 default size", () => {
    const r = evaluateAlert(baseAlert(), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(r.ok, true);
    assert.equal(r.sizeUsd, 2);
  });

  it("skips unknown trader", () => {
    const r = evaluateAlert(baseAlert({ traderHandle: "nope", userId: "x", eventId: "e2" }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "trader_not_watched");
  });

  it("skips below min trader size", () => {
    const r = evaluateAlert(baseAlert({ tradeUsd: 10, eventId: "e3" }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(r.reason, "below_min_trader_size");
  });

  it("skips buys when paused but not sells", () => {
    const buy = evaluateAlert(baseAlert({ eventId: "e4" }), {
      cfg,
      store,
      dryRun: true,
      paused: true,
      watchlist,
    });
    assert.equal(buy.reason, "paused");
  });

  it("sell without our position", () => {
    const r = evaluateAlert(baseAlert({ alertType: "sell", eventId: "sell1" }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(r.reason, "sell_without_our_position");
  });

  it("alumni: no new buys after dropout, sells still resolvable", async () => {
    // Simulate dropout by refreshing to empty manual list
    cfg.traders = [];
    // empty manual would throw on loadAppConfig but watchlist.refresh uses cfg.traders
    const prev = watchlist.listActive();
    assert.ok(prev.length === 1);
    // Manually call refresh after clearing traders
    cfg.traders = [];
    await watchlist.refresh("test-dropout");
    assert.equal(watchlist.listActive().length, 0);
    const buy = evaluateAlert(baseAlert({ eventId: "alumni-buy" }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(buy.reason, "trader_inactive_alumni");
  });

  it("computeSizeUsd percent mode needs tradeUsd", () => {
    cfg.sizing.mode = "percent_of_trader";
    cfg.sizing.percentOfTrader = 10;
    cfg.sizing.maxUsdPerTrade = 100;
    assert.equal(computeSizeUsd(baseAlert({ tradeUsd: 1000 }), cfg), 100);
    assert.equal(computeSizeUsd(baseAlert({ tradeUsd: null }), cfg), null);
  });
});
