import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadAppConfig, type EnvConfig } from "../src/config.js";
import { CopyEngine } from "../src/engine/copy.js";
import { buysSuppressedBySameBatch } from "../src/engine/batch.js";
import { decideExit } from "../src/engine/exits.js";
import { shouldPollRest } from "../src/engine/polling.js";
import { evaluateAlert } from "../src/engine/filters.js";
import { reconcileOpenPositions } from "../src/engine/reconcilePositions.js";
import { runTpSlPass } from "../src/engine/risk.js";
import { mapTraderSellToOurFraction, traderHoldState } from "../src/engine/sellFraction.js";
import { leaderboardTradeCount, Watchlist } from "../src/engine/watchlist.js";
import type { ExecutionRouter } from "../src/execution/index.js";
import { parallelSafetyAndOrder } from "../src/execution/solana.js";
import { closeAccountInstruction } from "../src/execution/closeAta.js";
import type { SwapRequest, SwapResult } from "../src/execution/types.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { roundTripRejection } from "../src/security/roundTrip.js";
import {
  evaluateSimulatedBalances,
  extraLamportsAllowed,
  WSOL_MINT,
} from "../src/security/simulateSwap.js";
import {
  evaluateLiquidity,
  evaluateTopHolder,
  fetchLargestHolderAmount,
  inspectSolanaMint,
  liquidityUsdFromDexScreener,
} from "../src/security/tokenSafety.js";
import { Store } from "../src/store/db.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import type { AppConfig, NormalizedAlert, OpenPosition } from "../src/types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-profit");
const MINT_A = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";
const MINT_B = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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
    tokenAddress: MINT_A,
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

class FakeExec {
  buys = 0;
  sells = 0;
  lastSellRaw: string | undefined;
  slippage: number[] = [];
  failSells = 0;
  outUsd: number | null = null;
  feeLamports = 5000;
  rentLamports = 2039280;
  inflight = 0;
  maxInflight = 0;
  delayMs = 0;
  ready() {
    return true;
  }
  async buyToken(req: SwapRequest): Promise<SwapResult> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.inflight--;
    this.buys++;
    return {
      ok: true,
      dryRun: req.dryRun,
      outAmountRaw: "1000000",
      outUsd: req.sellUsd,
      inUsd: req.sellUsd,
      inAmountRaw: "10000000",
      solInLamports: "10000000",
      feeLamports: this.feeLamports,
      rentLamports: this.rentLamports,
      quoteSummary: "fake",
    };
  }
  async sellToken(req: SwapRequest): Promise<SwapResult> {
    this.sells++;
    this.lastSellRaw = req.sellAmountRaw;
    this.slippage.push(req.slippageBps);
    if (this.failSells > 0) {
      this.failSells--;
      return { ok: false, dryRun: req.dryRun, error: "slippage" };
    }
    return {
      ok: true,
      dryRun: req.dryRun,
      outAmountRaw: "9000000",
      solOutLamports: "9000000",
      outUsd: this.outUsd ?? req.sellUsd,
      feeLamports: 5000,
      quoteSummary: "fake-sell",
    };
  }
}

function cfgManual(): AppConfig {
  const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
  cfg.traderSource = "manual";
  cfg.traders = [
    { handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana"] },
    { handle: "beta", userId: "uid-2", enabled: true, chains: ["solana"] },
  ];
  cfg.sizing.minTraderTradeUsd = 0;
  cfg.risk.cooldownSeconds = 0;
  return cfg;
}

async function setup(dir: string, dryRun: boolean, fake: FakeExec, cfg = cfgManual()) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const env: EnvConfig = {
    fomoApiKey: "",
    dryRun,
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
    killSwitchPath: path.join(dir, "kill.switch"),
  };
  const store = new Store(dir);
  const kill = new KillSwitch(env.killSwitchPath);
  const tg = new TelegramNotifier("", "");
  const watchlist = new Watchlist(cfg, null, undefined, store);
  await watchlist.start();
  const exec = {
    forChain: () => fake,
    buy: (_c: string, r: Omit<SwapRequest, "chain">) => fake.buyToken({ ...r, chain: "solana" }),
    sell: (_c: string, r: Omit<SwapRequest, "chain">) => fake.sellToken({ ...r, chain: "solana" }),
    solana: fake,
    base: null,
    prices: { rawOutToUsd: async () => null, getSolUsd: async () => ({ usd: 100, source: "test" }) },
  } as unknown as ExecutionRouter;
  const engine = new CopyEngine(env, cfg, store, exec, kill, tg, watchlist, null);
  return { cfg, env, store, kill, watchlist, engine, fake, tg, exec };
}

function tokData(amount: bigint): string {
  const buf = Buffer.alloc(165, 0);
  buf.writeBigUInt64LE(amount, 64);
  return buf.toString("base64");
}

describe("sim: fresh token account rent is allowed under the ceiling", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const outputAta = Keypair.generate().publicKey.toBase58();
  const outMint = Keypair.generate().publicKey.toBase58();
  const rent = 2_039_280;
  const reportedFees = 105_000;
  const expectedIn = 5_000_000n;
  const preSol = 20_000_000;

  function run(extraUnexplained: number) {
    const drop = Number(expectedIn) + rent + reportedFees + extraUnexplained;
    return evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: WSOL_MINT,
      outputMint: outMint,
      expectedInAmount: expectedIn,
      otherAmountThreshold: 1n,
      maxExtraLamports: 50_000,
      maxFeeLamports: 1_000_000,
      maxOverheadLamports: 3_000_000,
      reportedFeeLamports: reportedFees,
      maxExtraTokenOutflow: 0n,
      pre: { lamports: new Map([[wallet, preSol]]), tokenAmounts: new Map(), tokenMints: new Map() },
      watchedAddresses: [wallet, outputAta],
      postAccounts: [
        { address: wallet, lamports: preSol - drop, dataBase64: null },
        { address: outputAta, lamports: rent, dataBase64: tokData(100n) },
      ],
      inputTokenAccount: null,
      outputTokenAccount: outputAta,
    });
  }

  it("accepts ATA rent plus signature and priority fees", () => {
    const allowed = extraLamportsAllowed({
      observedRentLamports: BigInt(rent),
      maxExtraLamports: 50_000,
      maxFeeLamports: 1_000_000,
      maxOverheadLamports: 3_000_000,
      reportedFeeLamports: reportedFees,
    });
    assert.equal(allowed, BigInt(rent + reportedFees + 50_000));
    const r = run(0);
    assert.equal(r.ok, true, !r.ok ? r.error : "");
  });

  it("still rejects a drain above the 0.003 SOL ceiling", () => {
    const r = run(1_000_000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /overhead|ceiling|SOL outflow/);
  });

  it("rejects a large SOL drop when no new token account was created", () => {
    const r = evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: WSOL_MINT,
      outputMint: outMint,
      expectedInAmount: 1_000_000n,
      otherAmountThreshold: 1n,
      maxExtraLamports: 50_000,
      maxFeeLamports: 1_000_000,
      maxOverheadLamports: 3_000_000,
      reportedFeeLamports: 5_000,
      maxExtraTokenOutflow: 0n,
      pre: {
        lamports: new Map([
          [wallet, preSol],
          [outputAta, rent],
        ]),
        tokenAmounts: new Map([[outputAta, 0n]]),
        tokenMints: new Map([[outputAta, outMint]]),
      },
      watchedAddresses: [wallet, outputAta],
      postAccounts: [
        { address: wallet, lamports: preSol - 1_000_000 - 2_000_000, dataBase64: null },
        { address: outputAta, lamports: rent, dataBase64: tokData(50n) },
      ],
      inputTokenAccount: null,
      outputTokenAccount: outputAta,
    });
    assert.equal(r.ok, false);
  });
});

describe("no alert-age skip, same-batch sells", () => {
  it("does not skip old buys or buys with no timestamp", async () => {
    const { cfg, store, watchlist } = await setup(path.join(tmp, "stale"), true, new FakeExec());
    const old = evaluateAlert(alert({ eventId: "old", ts: Date.now() - 86_400_000 }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(old.ok, true);
    const missing = evaluateAlert(alert({ eventId: "missing", ts: null }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist,
    });
    assert.equal(missing.ok, true);
    store.close();
  });

  it("still dedupes a replayed event id after it was claimed", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmp, "stale-eng"), true, fake);
    const oldBuy = alert({ eventId: "old-buy", ts: Date.now() - 86_400_000 });
    await engine.handleAlert(oldBuy);
    await engine.handleAlert(oldBuy);
    assert.equal(fake.buys, 1);
    assert.equal(store.listOpen({ includeDryRun: true }).length, 1);
    assert.equal(store.hasEvent("old-buy"), true);
    store.close();
  });

  it("skips a buy when the same trader sells that token in the batch", async () => {
    const buy = alert({ eventId: "b1", alertType: "buy" });
    const sell = alert({ eventId: "s1", alertType: "sell", tradeUsd: 1000 });
    const other = alert({ eventId: "b2", tokenAddress: MINT_B, tokenSymbol: "OTHER" });
    const suppressed = buysSuppressedBySameBatch([buy, sell, other]);
    assert.equal(suppressed.has("b1"), true);
    assert.equal(suppressed.has("b2"), false);
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmp, "batch"), true, fake);
    await engine.handleAlerts([buy, sell, other]);
    assert.equal(fake.buys, 1);
    assert.equal(store.listSkips(10).some((s) => s.reason === "same_batch_sell"), true);
    const open = store.listOpen({ includeDryRun: true });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.tokenAddress, MINT_B);
    store.close();
  });
});

describe("exits: partial TP, trailing stop, max hold, slippage, retries", () => {
  const base = cfgManual();

  it("does not take profit, and trails only after a partial mirror arms it", () => {
    const pos: OpenPosition = {
      id: "p",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT_A,
      tokenSymbol: "TOK",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 2,
      quantityRaw: "100",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "e",
      status: "dry_open",
      isDryRun: true,
    };
    assert.equal("takeProfitPct" in base.risk, false);
    const up = decideExit({ pos, markUsd: 4, cfg: base });
    assert.equal(up.type, "hold");
    const unarmedDip = decideExit({
      pos: { ...pos, peakMarkUsd: 4 },
      markUsd: 3,
      cfg: base,
    });
    assert.equal(unarmedDip.type, "hold");
    const armed = decideExit({
      pos: { ...pos, trailArmed: true, remainingUsd: 1, peakMarkUsd: null },
      markUsd: 1.6,
      cfg: base,
    });
    assert.equal(armed.type, "seed_peak");
    const trail = decideExit({
      pos: { ...pos, trailArmed: true, remainingUsd: 1, peakMarkUsd: 1.6 },
      markUsd: 1.2,
      cfg: base,
    });
    assert.equal(trail.type, "close");
    if (trail.type === "close") assert.equal(trail.reason, "trailing_stop");
    const sl = decideExit({ pos, markUsd: 1, cfg: base });
    assert.equal(sl.type, "close");
    if (sl.type === "close") assert.equal(sl.reason, "stop_loss");
    const held = decideExit({
      pos: { ...pos, openedAt: new Date(Date.now() - 3 * 60_000).toISOString() },
      markUsd: 2,
      cfg: { ...base, risk: { ...base.risk, maxHoldMinutes: 2 } },
    });
    assert.equal(held.type, "close");
    if (held.type === "close") assert.equal(held.reason, "max_hold");
  });

  it("escalates sell slippage and retries a failed mirrored sell", async () => {
    const fake = new FakeExec();
    fake.failSells = 1;
    const dir = path.join(tmp, "retry");
    const { engine, store, cfg } = await setup(dir, true, fake);
    cfg.risk.mirroredSellMaxRetries = 4;
    cfg.risk.sellSlippageBps = [300, 1000, 2500];
    await engine.handleAlert(alert({ eventId: "buy-r", tradeUsd: 1000, positionValueUsd: 1000 }));
    await engine.handleAlert(
      alert({ eventId: "sell-r", alertType: "sell", tradeUsd: 1000, positionValueUsd: 1000 }),
    );
    assert.deepEqual(fake.slippage.slice(0, 2), [300, 1000]);
    const open = store.listOpen({ includeDryRun: true });
    assert.equal(open.length, 0);
    assert.equal(store.getSellRetry(open[0]?.id ?? "missing"), null);
    store.close();
  });

  it("queues a mirrored sell that exhausts the ladder and completes it on retry", async () => {
    const fake = new FakeExec();
    fake.failSells = 3;
    const { engine, store, cfg } = await setup(path.join(tmp, "queue"), true, fake);
    cfg.risk.sellSlippageBps = [300, 1000, 2500];
    cfg.risk.mirroredSellMaxRetries = 4;
    await engine.handleAlert(alert({ eventId: "buy-q" }));
    const id = store.listOpen({ includeDryRun: true })[0]!.id;
    await engine.handleAlert(alert({ eventId: "sell-q", alertType: "sell", tradeUsd: 1000 }));
    const queued = store.getSellRetry(id);
    assert.ok(queued);
    assert.equal(queued!.attempts, 1);
    assert.equal(store.hasEvent("sell-q"), true);
    assert.equal(store.listOpen({ includeDryRun: true }).length, 1);
    store.upsertSellRetry({ ...queued!, nextAttemptAt: 0 });
    await engine.drainSellRetries();
    assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
    assert.equal(store.getSellRetry(id), null);
    const closed = store.getPosition(id);
    assert.equal(closed?.status, "dry_closed");
    store.close();
  });

  it("writes off a position after N failed quotes and frees the slot", async () => {
    const { store, cfg, exec } = await (async () => {
      const s = await setup(path.join(tmp, "writeoff"), true, new FakeExec());
      return s;
    })();
    cfg.risk.quoteFailWriteoffCount = 3;
    cfg.risk.maxOpenPositions = 1;
    const pos: OpenPosition = {
      id: "dead",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT_A,
      tokenSymbol: "TOK",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 2,
      quantityRaw: "100",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "dead-src",
      status: "dry_open",
      isDryRun: true,
    };
    store.insertPosition(pos);
    const failing = {
      forChain: () => ({
        sellToken: async () => ({ ok: false, dryRun: true, error: "no route" }),
      }),
      prices: { rawOutToUsd: async () => null },
    } as unknown as ExecutionRouter;
    for (let i = 0; i < 3; i++) {
      await runTpSlPass({
        cfg,
        store,
        exec: failing,
        dryRun: true,
        onTrigger: async () => {},
      });
    }
    assert.equal(store.getPosition("dead")?.status, "dry_written_off");
    assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
    const next = evaluateAlert(alert({ eventId: "after-writeoff", tokenAddress: MINT_B }), {
      cfg,
      store,
      dryRun: true,
      paused: false,
      watchlist: (await setup(path.join(tmp, "writeoff-wl"), true, new FakeExec(), cfg)).watchlist,
    });
    void exec;
    assert.equal(next.ok, true);
    store.close();
  });

  it("resets positions stuck in closing", async () => {
    const { store } = await setup(path.join(tmp, "stuck"), true, new FakeExec());
    store.insertPosition({
      id: "stuck",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT_A,
      tokenSymbol: "TOK",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 2,
      quantityRaw: "10",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "stuck-src",
      status: "closing",
      isDryRun: true,
    });
    assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
    assert.equal(store.resetStuckClosing(), 1);
    assert.equal(store.listOpen({ includeDryRun: true })[0]?.status, "dry_open");
    store.close();
  });
});

describe("telegram /close /writeoff /stats stay inside the authorized chat", () => {
  it("ignores /close from the wrong user and runs it for an allowed user", async () => {
    const dir = path.join(tmp, "tg-close");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tg = new TelegramNotifier("token", "111", ["999"]);
    const kill = new KillSwitch(path.join(dir, "kill.switch"));
    const cfg = cfgManual();
    const store = new Store(dir);
    const calls: string[] = [];
    tg.attach({
      store,
      kill,
      cfg,
      dryRun: true,
      getWsStatus: () => "down",
      onCloseToken: async (q) => {
        calls.push(q);
        return `closed ${q}`;
      },
      onWriteoffToken: async (q) => {
        calls.push(`wo:${q}`);
        return `wrote off ${q}`;
      },
    });
    const original = globalThis.fetch;
    const updates = [
      { update_id: 1, message: { chat: { id: 111 }, from: { id: 222 }, text: "/close BONK" } },
      { update_id: 2, message: { chat: { id: 999 }, from: { id: 999 }, text: "/close BONK" } },
      { update_id: 3, message: { chat: { id: 111 }, from: { id: 999 }, text: "/close BONK" } },
      { update_id: 4, message: { chat: { id: 111 }, from: { id: 999 }, text: "/writeoff BONK" } },
    ];
    let i = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (!u.includes("getUpdates")) return new Response("{}", { status: 200 });
      const batch = updates.slice(i, i + 1);
      i += 1;
      return new Response(JSON.stringify({ ok: true, result: batch }), { status: 200 });
    }) as typeof fetch;
    await tg.pollUpdatesForTests();
    await tg.pollUpdatesForTests();
    await tg.pollUpdatesForTests();
    await tg.pollUpdatesForTests();
    globalThis.fetch = original;
    assert.deepEqual(calls, ["BONK", "wo:BONK"]);
    store.close();
  });
});

describe("mirrored trader sells", () => {
  it("maps under 10%, partial, full, and unknown", () => {
    assert.equal(mapTraderSellToOurFraction(0.05).action, "ignore");
    assert.equal(mapTraderSellToOurFraction(0.099).action, "ignore");
    const partial = mapTraderSellToOurFraction(0.1);
    assert.equal(partial.action, "sell");
    assert.equal(partial.ourFraction, 0.5);
    assert.equal(partial.armTrail, true);
    const mid = mapTraderSellToOurFraction(0.99);
    assert.equal(mid.ourFraction, 0.5);
    const full = mapTraderSellToOurFraction(1);
    assert.equal(full.ourFraction, 1);
    assert.equal(full.armTrail, false);
    const unknown = mapTraderSellToOurFraction(null);
    assert.equal(unknown.ourFraction, 0.5);
    assert.equal(unknown.armTrail, true);
  });

  it("ignores a sell under 10% and does not arm the trail", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmp, "mirror-small"), true, fake);
    await engine.handleAlert(alert({ eventId: "ms-buy", tradeUsd: 1000, positionValueUsd: 1000 }));
    await engine.handleAlert(alert({ eventId: "ms-sell", alertType: "sell", tradeUsd: 50 }));
    assert.equal(fake.sells, 0);
    const open = store.listOpen({ includeDryRun: true })[0]!;
    assert.equal(open.quantityRaw, "1000000");
    assert.equal(open.trailArmed, false);
    store.close();
  });

  it("sells half of ours on a 10–99% trader sell and arms the trail", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmp, "mirror-partial"), true, fake);
    await engine.handleAlert(alert({ eventId: "mp-buy", tradeUsd: 1000, positionValueUsd: 1000 }));
    await engine.handleAlert(alert({ eventId: "mp-sell", alertType: "sell", tradeUsd: 100 }));
    assert.equal(fake.lastSellRaw, "500000");
    const open = store.listOpen({ includeDryRun: true })[0]!;
    assert.equal(open.quantityRaw, "500000");
    assert.equal(open.trailArmed, true);
    assert.equal(open.peakMarkUsd, null);
    store.close();
  });

  it("sells the whole bag when the trader fully exits", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmp, "mirror-full"), true, fake);
    await engine.handleAlert(alert({ eventId: "mf-buy", tradeUsd: 1000, positionValueUsd: 1000 }));
    const id = store.listOpen({ includeDryRun: true })[0]!.id;
    await engine.handleAlert(alert({ eventId: "mf-sell", alertType: "sell", tradeUsd: 1000 }));
    assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
    assert.equal(store.getPosition(id)?.status, "dry_closed");
    store.close();
  });

  it("sells half when the trader fraction cannot be determined", async () => {
    const fake = new FakeExec();
    const { engine, store } = await setup(path.join(tmp, "mirror-unknown"), true, fake);
    await engine.handleAlert(alert({ eventId: "mu-buy", tradeUsd: 1000, positionValueUsd: 1000 }));
    await engine.handleAlert(
      alert({
        eventId: "mu-sell",
        alertType: "sell",
        tradeUsd: null,
        positionValueUsd: null,
        usdValue: null,
      }),
    );
    const open = store.listOpen({ includeDryRun: true })[0]!;
    assert.equal(open.quantityRaw, "500000");
    assert.equal(open.trailArmed, true);
    store.close();
  });
});

describe("rebuys, per-token cap, and sell-all", () => {
  it("merges adds into one position and caps per token", async () => {
    const fake = new FakeExec();
    const { engine, store, cfg } = await setup(path.join(tmp, "merge"), true, fake);
    cfg.sizing.mergeRebuys = true;
    cfg.sizing.maxUsdPerToken = 5;
    cfg.filters.firstBuysOnly = false;
    await engine.handleAlert(alert({ eventId: "m1", tradeId: "m1" }));
    await engine.handleAlert(alert({ eventId: "m2", tradeId: "m2" }));
    const open = store.listOpen({ includeDryRun: true });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.quantityRaw, "2000000");
    assert.equal(open[0]!.remainingUsd, 4);
    await engine.handleAlert(alert({ eventId: "m3", tradeId: "m3" }));
    assert.equal(store.listOpen({ includeDryRun: true }).length, 1);
    assert.equal(store.listSkips(5).some((s) => s.reason === "token_cap"), true);
    assert.equal(fake.buys, 2);
    store.close();
  });

  it("a trader sell closes every matching position", async () => {
    const fake = new FakeExec();
    const { engine, store, cfg } = await setup(path.join(tmp, "sellall"), true, fake);
    cfg.sizing.mergeRebuys = false;
    cfg.sizing.maxUsdPerToken = 10;
    await engine.handleAlert(alert({ eventId: "a1", tradeId: "a1" }));
    await engine.handleAlert(alert({ eventId: "a2", tradeId: "a2" }));
    assert.equal(store.listOpen({ includeDryRun: true }).length, 2);
    await engine.handleAlert(alert({ eventId: "sell-all", alertType: "sell", tradeUsd: 5000 }));
    assert.equal(store.listOpen({ includeDryRun: true }).length, 0);
    assert.equal(fake.sells >= 2, true);
    store.close();
  });
});

describe("per-trader cooldown", () => {
  it("does not block a different trader", async () => {
    const fake = new FakeExec();
    const { engine, store, cfg } = await setup(path.join(tmp, "cool"), true, fake);
    cfg.risk.cooldownSeconds = 60;
    await engine.handleAlert(alert({ eventId: "c1", tokenAddress: MINT_A }));
    await engine.handleAlert(
      alert({
        eventId: "c2",
        userId: "uid-2",
        traderHandle: "beta",
        tokenAddress: MINT_B,
        tokenSymbol: "BONK",
      }),
    );
    await engine.handleAlert(
      alert({ eventId: "c3", tokenAddress: MINT_B, tokenSymbol: "BONK" }),
    );
    assert.equal(fake.buys, 2);
    assert.equal(store.listSkips(10).some((s) => s.reason === "cooldown"), true);
    store.close();
  });
});

describe("leaderboard filters and auto-drop", () => {
  it("reads a trade count only when the row exposes one", () => {
    assert.equal(leaderboardTradeCount({ trades: 12 }), 12);
    assert.equal(leaderboardTradeCount({ tradeCount: "4" }), 4);
    assert.equal(leaderboardTradeCount({ handle: "x" }), null);
  });

  it("default cutoff needs 3 net-negative closes and does not fire at 2", async () => {
    const dir = path.join(tmp, "drop-default");
    fs.rmSync(dir, { recursive: true, force: true });
    const cfg = cfgManual();
    assert.equal(cfg.leaderboard.autoDropNegativePnl, true);
    assert.equal(cfg.leaderboard.autoDropMinCloses, 3);
    const store = new Store(dir);
    const closed = (id: string, pnl: number): OpenPosition => ({
      id,
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT_A,
      tokenSymbol: "T",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 0,
      quantityRaw: "0",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: id,
      status: "closed",
      isDryRun: false,
      realizedPnlUsd: pnl,
    });
    store.insertPosition(closed("d1", -1));
    store.insertPosition(closed("d2", -1));
    const early = new Watchlist(cfg, null, undefined, store);
    await early.start();
    assert.equal(early.listActive().some((t) => t.userId === "uid-1"), true);
    early.stop();
    store.insertPosition(closed("d3", -0.4));
    const later = new Watchlist(cfg, null, undefined, store);
    await later.start();
    assert.equal(later.listActive().some((t) => t.userId === "uid-1"), false);
    assert.equal(later.listActive().some((t) => t.userId === "uid-2"), true);
    later.stop();
    store.close();
  });

  it("drops a trader after N net-negative copied closes", async () => {
    const dir = path.join(tmp, "drop");
    fs.rmSync(dir, { recursive: true, force: true });
    const cfg = cfgManual();
    cfg.leaderboard.autoDropNegativePnl = true;
    cfg.leaderboard.autoDropMinCloses = 2;
    const store = new Store(dir);
    store.insertPosition({
      id: "c1",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT_A,
      tokenSymbol: "T",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 0,
      quantityRaw: "0",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "c1",
      status: "closed",
      isDryRun: false,
      realizedPnlUsd: -1,
    });
    store.insertPosition({
      id: "c2",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT_B,
      tokenSymbol: "U",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 0,
      quantityRaw: "0",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "c2",
      status: "closed",
      isDryRun: false,
      realizedPnlUsd: -0.5,
    });
    const wl = new Watchlist(cfg, null, undefined, store);
    await wl.start();
    assert.equal(wl.listActive().some((t) => t.userId === "uid-1"), false);
    assert.equal(wl.listActive().some((t) => t.userId === "uid-2"), true);
    const stats = store.listTraderStats(false);
    assert.equal(stats[0]?.traderHandle, "alpha");
    assert.equal(stats[0]?.closes, 2);
    assert.equal(stats[0]?.wins, 0);
    assert.ok((stats[0]?.realizedPnlUsd ?? 0) < 0);
    store.close();
  });
});

describe("token safety fails closed", () => {
  it("blocks an active mint authority and a failed inspect", async () => {
    const blocked = await inspectSolanaMint("http://127.0.0.1:9", MINT_A, {
      mode: "block",
      blockMintAuthority: true,
      getParsedAccountInfo: async () => ({
        owner: TOKEN_PROGRAM,
        parsed: { parsed: { type: "mint", info: { mintAuthority: "StillMinting", freezeAuthority: null, supply: "10000" } } },
      }),
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.blockReason, "mint_authority");
    const ok = await inspectSolanaMint("http://127.0.0.1:9", MINT_A, {
      mode: "block",
      blockMintAuthority: true,
      getParsedAccountInfo: async () => ({
        owner: TOKEN_PROGRAM,
        parsed: { parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, supply: "10000" } } },
      }),
    });
    assert.equal(ok.blocked, false);
    const down = await inspectSolanaMint("http://127.0.0.1:9", MINT_A, {
      mode: "block",
      getParsedAccountInfo: async () => {
        throw new Error("rpc down");
      },
    });
    assert.equal(down.blocked, true);
    assert.equal(down.blockReason, "inspect_failed");
  });

  it("blocks concentrated holders, thin liquidity, and a bad round trip", async () => {
    const hot = evaluateTopHolder({
      maxTopHolderBps: 9000,
      topAmount: 9500n,
      supply: 10_000n,
      fetchFailed: false,
    });
    assert.equal(hot.blocked, true);
    const spread = evaluateTopHolder({
      maxTopHolderBps: 9000,
      topAmount: 1000n,
      supply: 10_000n,
      fetchFailed: false,
    });
    assert.equal(spread.blocked, false);
    const failedHolders = evaluateTopHolder({
      maxTopHolderBps: 9000,
      topAmount: null,
      supply: null,
      fetchFailed: true,
    });
    assert.equal(failedHolders.blocked, true);
    const off = evaluateTopHolder({
      maxTopHolderBps: 0,
      topAmount: null,
      supply: null,
      fetchFailed: true,
    });
    assert.equal(off.blocked, false);

    assert.equal(
      evaluateLiquidity({ minLiquidityUsd: 1000, liquidityUsd: null, fetchFailed: true }).blocked,
      true,
    );
    assert.equal(
      evaluateLiquidity({ minLiquidityUsd: 0, liquidityUsd: null, fetchFailed: true }).blocked,
      false,
    );
    assert.equal(
      evaluateLiquidity({ minLiquidityUsd: 1000, liquidityUsd: 5000, fetchFailed: false }).blocked,
      false,
    );
    assert.equal(
      liquidityUsdFromDexScreener({
        pairs: [
          { chainId: "ethereum", quoteToken: { address: "0xabc" }, liquidity: { usd: 999999 } },
          {
            chainId: "solana",
            quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
            liquidity: { usd: 12000 },
          },
        ],
      }),
      12000,
    );
    const limited = await fetchLargestHolderAmount(
      "http://rpc.example",
      MINT_A,
      async () => new Response("no", { status: 429 }),
    );
    assert.equal(limited.failed, true);
    assert.equal(limited.amount, null);
    const parsed = await fetchLargestHolderAmount(
      "http://rpc.example",
      MINT_A,
      async () =>
        new Response(JSON.stringify({ result: { value: [{ amount: "42" }] } }), { status: 200 }),
    );
    assert.equal(parsed.failed, false);
    assert.equal(parsed.amount, 42n);

    assert.match(roundTripRejection(2, 1, 2500) ?? "", /round_trip/);
    assert.equal(roundTripRejection(2, 1.8, 2500), null);
    assert.match(roundTripRejection(2, null, 2500) ?? "", /fail closed/);
  });
});

describe("latency: telegram, snapshot, parallel quotes, per-token locks", () => {
  it("does not wait for Telegram inside the alert path", async () => {
    const dir = path.join(tmp, "tg-hang");
    const fake = new FakeExec();
    const base = await setup(dir, true, fake);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    class Hang extends TelegramNotifier {
      override async send(): Promise<void> {
        await gate;
      }
    }
    const tg = new Hang("token", "1");
    const engine = new CopyEngine(base.env, base.cfg, base.store, base.exec, base.kill, tg, base.watchlist);
    const finished = engine.handleAlert(alert({ eventId: "hang-tg" }));
    const winner = await Promise.race([
      finished.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 400)),
    ]);
    assert.equal(winner, "done");
    release();
    await finished;
    base.store.close();
  });

  it("does not wait for the FOMO positions snapshot before opening", async () => {
    const dir = path.join(tmp, "snap");
    const fake = new FakeExec();
    const base = await setup(dir, true, fake);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fomo = {
      positions: async () => {
        await gate;
        return { positions: [{ token: { address: MINT_A }, amount: 10, status: "open" }] };
      },
    };
    const engine = new CopyEngine(
      base.env,
      base.cfg,
      base.store,
      base.exec,
      base.kill,
      base.tg,
      base.watchlist,
      fomo as never,
    );
    const finished = engine.handleAlert(alert({ eventId: "snap-1" }));
    const winner = await Promise.race([
      finished.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 400)),
    ]);
    assert.equal(winner, "done");
    assert.equal(base.store.listOpen({ includeDryRun: true }).length, 1);
    release();
    await finished;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(base.store.listOpen({ includeDryRun: true })[0]?.traderTokenAmountAtEntry, 10);
    base.store.close();
  });

  it("starts the safety check and the order request together", async () => {
    let inflight = 0;
    let max = 0;
    const work = async () => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return 1;
    };
    await parallelSafetyAndOrder(work, work);
    assert.equal(max, 2);
  });

  it("overlaps different tokens and serializes the same token", async () => {
    const fake = new FakeExec();
    fake.delayMs = 40;
    const { engine, store } = await setup(path.join(tmp, "locks"), true, fake);
    await Promise.all([
      engine.handleAlert(alert({ eventId: "p1", tokenAddress: MINT_A })),
      engine.handleAlert(alert({ eventId: "p2", tokenAddress: MINT_B, tokenSymbol: "B" })),
    ]);
    assert.equal(fake.maxInflight, 2);
    const fake2 = new FakeExec();
    fake2.delayMs = 40;
    const second = await setup(path.join(tmp, "locks-same"), true, fake2);
    await Promise.all([
      second.engine.handleAlert(alert({ eventId: "s1", tokenAddress: MINT_A })),
      second.engine.handleAlert(alert({ eventId: "s2", tokenAddress: MINT_A })),
    ]);
    assert.equal(fake2.maxInflight, 1);
    assert.equal(second.store.listOpen({ includeDryRun: true }).length, 1);
    store.close();
    second.store.close();
  });

  it("does not let two tokens overspend one daily budget", async () => {
    const fake = new FakeExec();
    fake.delayMs = 30;
    const { engine, store, cfg } = await setup(path.join(tmp, "budget-race"), false, fake);
    cfg.risk.dailyBudgetUsd = 3;
    cfg.sizing.fixedUsd = 2;
    cfg.sizing.maxUsdPerToken = 5;
    cfg.risk.dailyLossLimitUsd = 0;
    await Promise.all([
      engine.handleAlert(alert({ eventId: "bud1", tokenAddress: MINT_A })),
      engine.handleAlert(alert({ eventId: "bud2", tokenAddress: MINT_B, tokenSymbol: "B" })),
    ]);
    assert.equal(fake.buys, 1);
    assert.equal(store.getDaily().spentUsd, 2);
    assert.equal(store.listOpen().length, 1);
    store.close();
  });
});

describe("reconcile, pnl, daily loss, rest polling, close-account ix", () => {
  it("exits when the trader is flat and does nothing when the book is unreadable", async () => {
    const { store, engine } = await setup(path.join(tmp, "recon"), true, new FakeExec());
    await engine.handleAlert(alert({ eventId: "recon-buy" }));
    const pos = store.listOpen({ includeDryRun: true })[0]!;
    const unknown = await reconcileOpenPositions({
      store,
      includeDryRun: true,
      fomo: {
        positions: async () => {
          throw new Error("402");
        },
      } as never,
      onFlat: async () => {
        throw new Error("should not flatten");
      },
    });
    assert.equal(unknown.flat, 0);
    assert.equal(store.listOpen({ includeDryRun: true }).length, 1);
    assert.equal(traderHoldState({ available: false }, MINT_A), "unknown");
    assert.equal(traderHoldState({ positions: [] }, MINT_A), "unknown");
    assert.equal(
      traderHoldState({ positions: [{ token: { address: "other" }, status: "open", amount: 1 }] }, MINT_A),
      "absent",
    );
    const flat = await reconcileOpenPositions({
      store,
      includeDryRun: true,
      fomo: {
        positions: async () => ({
          positions: [{ token: { address: MINT_A }, status: "closed", amount: 0 }],
        }),
      } as never,
      onFlat: async (p) => {
        await engine.closePosition(p, "reconcile_flat");
      },
    });
    assert.equal(flat.flat, 1);
    assert.equal(store.getPosition(pos.id)?.status, "dry_closed");
    store.close();
  });

  it("stores USD, fees, and rent and paper PnL is queryable", async () => {
    const fake = new FakeExec();
    fake.outUsd = 3;
    const { engine, store } = await setup(path.join(tmp, "pnl"), true, fake);
    await engine.handleAlert(alert({ eventId: "pnl-buy", tradeUsd: 1000, positionValueUsd: 1000 }));
    const open = store.listOpen({ includeDryRun: true })[0]!;
    assert.equal(open.usdIn, 2);
    assert.equal(open.feeLamports, "5000");
    assert.equal(open.rentPaidLamports, "2039280");
    assert.equal(open.solInLamports, "10000000");
    await engine.handleAlert(
      alert({ eventId: "pnl-sell", alertType: "sell", tradeUsd: 1000, positionValueUsd: 1000 }),
    );
    const closed = store.getPosition(open.id)!;
    assert.equal(closed.status, "dry_closed");
    assert.equal(closed.usdOut, 3);
    assert.ok((closed.realizedPnlUsd ?? 0) > 0);
    assert.equal(store.getDaily().realizedPnlUsd, 0);
    assert.ok(store.getDaily().paperRealizedPnlUsd > 0);
    const stats = store.listTraderStats(true);
    assert.equal(stats[0]?.wins, 1);
    assert.equal(stats[0]?.closes, 1);
    store.close();
  });

  it("daily realized-loss limit blocks new entries and still allows sells", async () => {
    const fake = new FakeExec();
    const { engine, store, cfg, watchlist } = await setup(path.join(tmp, "loss"), false, fake);
    cfg.risk.dailyLossLimitUsd = 20;
    cfg.risk.dailyBudgetUsd = 40;
    await engine.handleAlert(alert({ eventId: "loss-buy" }));
    store.addRealizedPnl(-25);
    const blocked = evaluateAlert(alert({ eventId: "loss-buy-2", tokenAddress: MINT_B }), {
      cfg,
      store,
      dryRun: false,
      paused: false,
      watchlist,
    });
    assert.equal(blocked.reason, "daily_loss_limit");
    await engine.handleAlert(
      alert({ eventId: "loss-sell", alertType: "sell", tradeUsd: 1000, positionValueUsd: 1000 }),
    );
    assert.equal(store.listOpen().length, 0);
    assert.equal(fake.sells > 0, true);
    store.close();
  });

  it("polls REST only as a fallback while the socket is down", () => {
    assert.equal(shouldPollRest({ enabled: true, onlyWhenWsDown: true, wsHealthy: true }), false);
    assert.equal(shouldPollRest({ enabled: true, onlyWhenWsDown: true, wsHealthy: false }), true);
    assert.equal(shouldPollRest({ enabled: true, onlyWhenWsDown: false, wsHealthy: true }), true);
    assert.equal(shouldPollRest({ enabled: false, onlyWhenWsDown: false, wsHealthy: false }), false);
  });

  it("builds a close-account instruction", () => {
    const owner = Keypair.generate().publicKey;
    const account = Keypair.generate().publicKey;
    const ix = closeAccountInstruction({ account, destination: owner, owner });
    assert.equal(ix.data[0], 9);
    assert.equal(ix.keys[0]?.pubkey.equals(account), true);
    assert.equal(ix.keys[1]?.pubkey.equals(owner), true);
    assert.equal(ix.keys[2]?.pubkey.equals(owner), true);
    assert.equal(ix.programId.equals(new PublicKey(TOKEN_PROGRAM)), true);
  });

  it("example config keeps the safe size defaults and Node 22.5", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    assert.equal(cfg.sizing.fixedUsd, 2);
    assert.equal(cfg.sizing.maxUsdPerTrade, 5);
    assert.equal(cfg.risk.dailyBudgetUsd, 40);
    assert.equal(cfg.leaderboard.window, "30d");
    assert.equal(cfg.filters.maxTopHolderBps, 9000);
    assert.equal(cfg.filters.minLiquidityUsd, 10_000);
    assert.equal(cfg.filters.blockMintAuthority, true);
    assert.equal(cfg.filters.blockFreezeAuthority, true);
    assert.equal(cfg.filters.roundTripMaxLossBps, 2500);
    assert.equal(cfg.leaderboard.autoDropNegativePnl, true);
    assert.equal(cfg.leaderboard.autoDropMinCloses, 3);
    assert.equal("maxAlertAgeSec" in cfg.filters, false);
    assert.equal("takeProfitPct" in cfg.risk, false);
    assert.equal("takeProfitSellFraction" in cfg.risk, false);
    assert.equal(cfg.risk.simMaxOverheadLamports, 5_000_000);
    assert.equal(cfg.risk.stopLossPct, 25);
    assert.equal(cfg.risk.trailingStopPct, 20);
    assert.equal(cfg.risk.dailyLossLimitUsd, 20);
    assert.equal(cfg.risk.quoteFailWriteoffCount, 5);
    assert.equal(cfg.poll.alertsRestIntervalSec, 90);
    assert.equal(cfg.poll.alertsRestOnlyWhenWsDown, true);
    assert.equal(cfg.poll.tpSlCheckIntervalSec, 15);
    assert.deepEqual(cfg.risk.sellSlippageBps, [300, 1000, 2500]);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    assert.equal(pkg.engines.node, ">=22.5");
  });
});
