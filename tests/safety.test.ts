import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../src/config.js";
import { CopyEngine } from "../src/engine/copy.js";
import { evaluateAlert } from "../src/engine/filters.js";
import { Watchlist } from "../src/engine/watchlist.js";
import type { Executor, SwapRequest, SwapResult } from "../src/execution/types.js";
import { ExecutionRouter } from "../src/execution/index.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { Store } from "../src/store/db.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { sellFraction, scaleRawAmount, usdToTokenRaw, rawToUsd } from "../src/utils/money.js";
import type { AppConfig, NormalizedAlert } from "../src/types.js";
import type { EnvConfig } from "../src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(root, "data", "test-safety");

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
    tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
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

class FakeExec implements Executor {
  readonly chain = "solana" as const;
  buys = 0;
  sells = 0;
  signed = false;
  lastSellRaw: string | undefined;
  constructor(private readonly dryOk = true) {}
  ready() {
    return true;
  }
  async buyToken(req: SwapRequest): Promise<SwapResult> {
    this.buys++;
    if (!req.dryRun) this.signed = true;
    if (!this.dryOk && req.dryRun) return { ok: false, dryRun: true, error: "quote fail" };
    return {
      ok: true,
      dryRun: req.dryRun,
      outAmountRaw: "1000000",
      outUsd: req.sellUsd,
      quoteSummary: "fake",
    };
  }
  async sellToken(req: SwapRequest): Promise<SwapResult> {
    this.sells++;
    this.lastSellRaw = req.sellAmountRaw;
    if (!req.dryRun) this.signed = true;
    return {
      ok: true,
      dryRun: req.dryRun,
      outAmountRaw: "500000000",
      outUsd: req.sellUsd,
      quoteSummary: "fake-sell",
    };
  }
}

function cfgManual(): AppConfig {
  const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
  cfg.traderSource = "manual";
  cfg.traders = [
    { handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana", "base"] },
  ];
  cfg.sizing.minTraderTradeUsd = 0;
  cfg.risk.cooldownSeconds = 0;
  return cfg;
}

async function setup(dir: string, dryRun: boolean, fake: FakeExec) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfg = cfgManual();
  const env: EnvConfig = {
    fomoApiKey: "",
    dryRun,
    solanaRpcUrl: "",
    solanaPrivateKey: "",
    jupiterApiKey: "",
    baseRpcUrl: "",
    basePrivateKey: "",
    zeroXApiKey: "",
    telegramBotToken: "",
    telegramChatId: "",
    configPath: "",
    dataDir: dir,
    killSwitchPath: path.join(dir, "kill.switch"),
      telegramAllowedUserIds: [],
  };
  const store = new Store(dir);
  const kill = new KillSwitch(env.killSwitchPath);
  const tg = new TelegramNotifier("", "");
  const watchlist = new Watchlist(cfg, null, undefined, store);
  await watchlist.start();
  const exec = {
    solana: fake,
    base: fake,
    forChain: (c: string) => (c === "solana" || c === "base" ? fake : null),
    buy: (c: string, r: Omit<SwapRequest, "chain">) => fake.buyToken({ ...r, chain: c as "solana" }),
    sell: (c: string, r: Omit<SwapRequest, "chain">) => fake.sellToken({ ...r, chain: c as "solana" }),
  } as unknown as ExecutionRouter;
  const engine = new CopyEngine(env, cfg, store, exec, kill, tg, watchlist);
  return { cfg, env, store, kill, watchlist, engine, fake };
}

describe("safety: money helpers", () => {
  it("usdToTokenRaw / rawToUsd USDC 6 decimals", () => {
    assert.equal(usdToTokenRaw(2, 6, 1), "2000000");
    assert.ok(Math.abs((rawToUsd("2000000", 6, 1) ?? 0) - 2) < 1e-9);
  });
  it("sellFraction proportional and full fallback", () => {
    assert.equal(sellFraction({ traderSellUsd: 250, traderSizeAtEntryUsd: 1000 }), 0.25);
    assert.equal(sellFraction({ traderSellUsd: null, traderSizeAtEntryUsd: 1000 }), 1);
    assert.equal(scaleRawAmount("1000", 0.25), "250");
  });
});

describe("safety: claimEvent dedupe + no double buy", () => {
  it("claimEventStrict only once", () => {
    const dir = path.join(tmpRoot, "claim");
    fs.rmSync(dir, { recursive: true, force: true });
    const store = new Store(dir);
    assert.equal(store.claimEventStrict("e1"), true);
    assert.equal(store.claimEventStrict("e1"), false);
    store.close();
  });

  it("duplicate/replayed alert does not buy twice", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmpRoot, "dup"), true, fake);
    const a = alert({ eventId: "same-event" });
    await engine.handleAlert(a);
    await engine.handleAlert({ ...a }); // replay
    assert.equal(fake.buys, 1);
    assert.equal(store.listOpen({ includeDryRun: true }).length, 1);
    store.close();
  });

  it("concurrent alerts serialize — only one buy for same event", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmpRoot, "race"), true, fake);
    const a = alert({ eventId: "race-event" });
    await Promise.all([engine.handleAlert(a), engine.handleAlert({ ...a })]);
    assert.equal(fake.buys, 1);
    store.close();
  });
});

describe("safety: DRY_RUN never signs; live without keys fails closed", () => {
  it("dry-run uses dry_open and does not add live spend", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmpRoot, "dry"), true, fake);
    await engine.handleAlert(alert({ eventId: "dry1" }));
    assert.equal(fake.signed, false);
    assert.equal(store.countOpenLive(), 0);
    assert.equal(store.listOpen({ includeDryRun: true })[0]?.status, "dry_open");
    assert.equal(store.getDaily().spentUsd, 0);
    store.close();
  });

  it("live executor without key returns ok:false (SolanaExecutor)", async () => {
    const cfg = cfgManual();
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: false,
      solanaRpcUrl: "http://127.0.0.1",
      solanaPrivateKey: "",
      jupiterApiKey: "",
      baseRpcUrl: "http://127.0.0.1",
      basePrivateKey: "",
      zeroXApiKey: "",
      telegramBotToken: "",
      telegramChatId: "",
      configPath: "",
      dataDir: path.join(tmpRoot, "livefail"),
      killSwitchPath: path.join(tmpRoot, "livefail", "kill.switch"),
      telegramAllowedUserIds: [],
    };
    fs.mkdirSync(env.dataDir, { recursive: true });
    const router = new ExecutionRouter(env, cfg);
    const r = await router.buy("solana", {
      sellToken: "",
      buyToken: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
      sellUsd: 2,
      slippageBps: 100,
      dryRun: false,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /SOLANA_PRIVATE_KEY/);
  });
});

describe("safety: kill switch blocks entries only", () => {
  it("paused blocks buys but allows sell evaluation", async () => {
    const dir = path.join(tmpRoot, "kill");
    const fake = new FakeExec();
    const { cfg, store, kill, watchlist, engine } = await setup(dir, true, fake);
    await engine.handleAlert(alert({ eventId: "k-buy" }));
    kill.pause("test");
    const buy = evaluateAlert(alert({ eventId: "k-buy2" }), {
      cfg,
      store,
      dryRun: true,
      paused: true,
      watchlist,
    });
    assert.equal(buy.reason, "paused");
    const sell = evaluateAlert(
      alert({
        eventId: "k-sell",
        alertType: "sell",
        tradeUsd: 1000,
      }),
      { cfg, store, dryRun: true, paused: true, watchlist },
    );
    assert.equal(sell.ok, true);
    // disk delete resumes
    kill.resume();
    assert.equal(kill.isPaused(), false);
    store.close();
  });
});

describe("safety: failed swap creates no phantom position", () => {
  it("buy failure after claim leaves no open position", async () => {
    const fake = new FakeExec();
    fake.buyToken = async (req) => {
      fake.buys++;
      return { ok: false, dryRun: req.dryRun, error: "boom" };
    };
    const { engine, store } = await setup(path.join(tmpRoot, "phantom"), true, fake);
    await engine.handleAlert(alert({ eventId: "fail-buy" }));
    assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
    assert.equal(store.hasEvent("fail-buy"), true);
    store.close();
  });
});

describe("safety: partial sell sizing", () => {
  it("sells proportional raw amount", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmpRoot, "partial"), true, fake);
    await engine.handleAlert(
      alert({ eventId: "p-buy", tradeUsd: 1000, positionValueUsd: 1000 }),
    );
    const open = store.listOpen({ includeDryRun: true })[0]!;
    assert.equal(open.quantityRaw, "1000000");
    await engine.handleAlert(
      alert({
        eventId: "p-sell",
        alertType: "sell",
        tradeUsd: 250, // 25% of 1000
      }),
    );
    assert.equal(fake.lastSellRaw, "250000");
    const after = store.listOpen({ includeDryRun: true })[0];
    assert.ok(after); // partial remains open
    assert.equal(after!.quantityRaw, "750000");
    store.close();
  });
});

describe("safety: daily budget persists across Store reopen", () => {
  it("spentUsd survives restart", async () => {
    const dir = path.join(tmpRoot, "budget");
    const fake = new FakeExec();
    const s1 = await setup(dir, false, fake);
    // force live path with fake exec that returns live ok
    s1.env.dryRun = false;
    const engine = new CopyEngine(
      s1.env,
      s1.cfg,
      s1.store,
      {
        forChain: () => fake,
        buy: (_c: string, r: Omit<SwapRequest, "chain">) =>
          fake.buyToken({ ...r, chain: "solana", dryRun: false }),
        sell: (_c: string, r: Omit<SwapRequest, "chain">) =>
          fake.sellToken({ ...r, chain: "solana", dryRun: false }),
        solana: fake,
        base: fake,
      } as unknown as ExecutionRouter,
      s1.kill,
      new TelegramNotifier("", ""),
      s1.watchlist,
    );
    s1.cfg.risk.dailyBudgetUsd = 3;
    s1.cfg.sizing.fixedUsd = 2;
    await engine.handleAlert(alert({ eventId: "b1" }));
    assert.equal(s1.store.getDaily().spentUsd, 2);
    s1.store.close();
    const store2 = new Store(dir);
    assert.equal(store2.getDaily().spentUsd, 2);
    const watchlist = new Watchlist(s1.cfg, null, undefined, store2);
    await watchlist.start();
    const blocked = evaluateAlert(alert({ eventId: "b2" }), {
      cfg: s1.cfg,
      store: store2,
      dryRun: false,
      paused: false,
      watchlist,
    });
    // 2 + 2 > 3
    assert.equal(blocked.reason, "daily_budget");
    store2.close();
  });
});

describe("safety: Telegram command auth", () => {
  it("ignores commands from other chat ids", async () => {
    const tg = new TelegramNotifier("token", "111");
    const ignored: string[] = [];
    // Access private via any — call handle through poll simulation by monkeypatching fetch
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: { chat: { id: 999 }, text: "/pause" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      ignored.push(u);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const dir = path.join(tmpRoot, "tg");
    fs.mkdirSync(dir, { recursive: true });
    const kill = new KillSwitch(path.join(dir, "kill.switch"));
    const cfg = cfgManual();
    const store = new Store(dir);
    tg.attach({
      store,
      kill,
      cfg,
      dryRun: true,
      getWsStatus: () => "ok",
    });
    // invoke private pollUpdates
    await tg.pollUpdatesForTests();
    assert.equal(kill.isPaused(), false); // foreign chat must not pause
    globalThis.fetch = original;
    store.close();
  });
});

describe("safety: alumni subscribe keys keep open traders", () => {
  it("subscribeKeysWithOpen retains dropout trader + persists alumni in SQLite", async () => {
    const dir = path.join(tmpRoot, "alumni-persist");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const cfg = cfgManual();
    const store = new Store(dir);
    const wl = new Watchlist(cfg, null, undefined, store);
    await wl.start();
    cfg.traders = [];
    await wl.refresh("drop");
    assert.equal(wl.listActive().length, 0);
    assert.equal(wl.listAlumni().length, 1);
    const keys = wl.subscribeKeysWithOpen(["uid-1", "alpha"]);
    assert.ok(keys.includes("alpha") || keys.includes("uid-1"));
    store.close();
    // Restart: alumni must reload from SQLite
    const store2 = new Store(dir);
    const wl2 = new Watchlist(cfg, null, undefined, store2);
    await wl2.start();
    assert.equal(wl2.listAlumni().length, 1);
    assert.equal(wl2.listAlumni()[0]!.userId, "uid-1");
    store2.close();
  });
});
