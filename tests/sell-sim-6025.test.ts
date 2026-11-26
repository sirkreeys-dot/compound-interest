import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VersionedTransaction } from "@solana/web3.js";
import { loadAppConfig } from "../src/config.js";
import { ExecutionRouter } from "../src/execution/index.js";
import {
  backoffWithJitter,
  clearJupiterCacheForTests,
  jupiterFetch,
  JupiterLimiter,
  setRateLimitSleepForTests,
} from "../src/execution/jupiterLimit.js";
import { assertLiveAllowed, liveTradingEnabled } from "../src/security/dryRunGuard.js";
import {
  classifySellSimulation,
  nextSimAction,
  quoteFailureReason,
  sellSimLogLine,
  sellSimReasonFromRpc,
  sellSimVerdict,
} from "../src/security/sellSim.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import type { EnvConfig } from "../src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("6025 is not a honeypot", () => {
  it("classifies Jupiter InvalidTokenAccount 6025 as inconclusive and refuses after one retry", () => {
    const err = { InstructionError: [7, { Custom: 6025 }] };
    assert.equal(classifySellSimulation(err), "inconclusive");
    assert.equal(sellSimReasonFromRpc({ err }), "sim_inconclusive");
    const line = sellSimLogLine("sim_inconclusive", true, JSON.stringify(err));
    assert.match(line, /outcome=failed/);
    assert.match(line, /reason=sim_inconclusive/);
    assert.doesNotMatch(line, /reason=honeypot/);
    assert.equal(sellSimVerdict("sim_inconclusive", true).refuseBuy, true);
    assert.equal(nextSimAction("sim_inconclusive", 0), "requote");
    assert.equal(nextSimAction("sim_inconclusive", 1), "done");
  });

  it("still classifies a frozen account as a honeypot", () => {
    const err = { InstructionError: [0, { Custom: 17 }] };
    assert.equal(classifySellSimulation(err, ["Program log: Error: Account is frozen"]), "honeypot");
    const line = sellSimLogLine("honeypot", true, "Account is frozen");
    assert.match(line, /reason=honeypot/);
    assert.equal(sellSimVerdict("honeypot", false).refuseBuy, true);
  });

  it("classifies slippage 6001 as inconclusive, not a honeypot", () => {
    assert.equal(classifySellSimulation({ InstructionError: [3, { Custom: 6001 }] }), "inconclusive");
  });
});

describe("429 is rate_limited", () => {
  it("does not call a Jupiter 429 a missing route", () => {
    assert.equal(quoteFailureReason("Jupiter quote 429: Too many requests"), "rate_limited");
    assert.equal(quoteFailureReason("Could not find any route"), "no_route");
    const line = sellSimLogLine("rate_limited", true, "Jupiter quote 429");
    assert.match(line, /reason=rate_limited/);
    assert.equal(sellSimVerdict("rate_limited", true).refuseBuy, true);
  });

  it("backs off with jitter and caches a quote GET, not an execute POST", async () => {
    assert.ok(backoffWithJitter(1000, 0) >= 1000);
    assert.ok(backoffWithJitter(1000, 0.99) <= 1250);
    clearJupiterCacheForTests();
    let gets = 0;
    let posts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") posts++;
      else gets++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const limiter = new JupiterLimiter(100);
    try {
      await jupiterFetch("https://api.jup.ag/swap/v1/quote?amount=1", { method: "GET" }, {
        priority: "buy",
        limiter,
      });
      await jupiterFetch("https://api.jup.ag/swap/v1/quote?amount=1", { method: "GET" }, {
        priority: "buy",
        limiter,
      });
      assert.equal(gets, 1);
      await jupiterFetch("https://api.jup.ag/swap/v2/execute", { method: "POST", body: "{}" }, {
        priority: "sell",
        limiter,
        retry429: false,
      });
      await jupiterFetch("https://api.jup.ag/swap/v2/execute", { method: "POST", body: "{}" }, {
        priority: "sell",
        limiter,
        retry429: false,
      });
      assert.equal(posts, 2);
      setRateLimitSleepForTests(async () => {});
      let limited = 0;
      const res = await jupiterFetch("https://api.jup.ag/swap/v1/quote?amount=429", { method: "GET" }, {
        priority: "buy",
        limiter,
        fetchImpl: (async () => {
          limited++;
          return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
        }) as typeof fetch,
      });
      assert.equal(res.status, 429);
      assert.equal(limited, 3);
    } finally {
      globalThis.fetch = original;
      setRateLimitSleepForTests(null);
    }
  });
});

describe("DRY_RUN guard", () => {
  it("throws unless DRY_RUN is explicitly false, and config cannot bypass it", async () => {
    const prev = process.env.DRY_RUN;
    const sign = VersionedTransaction.prototype.sign;
    let signed = 0;
    let executed = 0;
    VersionedTransaction.prototype.sign = function () {
      signed++;
      throw new Error("SIGN CALLED");
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/execute")) {
        executed++;
        throw new Error("EXECUTE CALLED");
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      delete process.env.DRY_RUN;
      assert.equal(liveTradingEnabled(), false);
      assert.throws(() => assertLiveAllowed(), /DRY_RUN guard/);
      process.env.DRY_RUN = "true";
      assert.throws(() => assertLiveAllowed(), /DRY_RUN guard/);
      const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
      const dir = path.join(root, "data", "test-dry-guard");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const env: EnvConfig = {
        fomoApiKey: "",
        dryRun: false,
        solanaRpcUrl: "http://127.0.0.1:1",
        solanaPrivateKey: "",
        jupiterApiKey: "",
        baseRpcUrl: "",
        basePrivateKey: "",
        zeroXApiKey: "",
        telegramBotToken: "",
        telegramChatId: "",
        telegramAllowedUserIds: [],
        configPath: path.join(root, "config.example.yaml"),
        dataDir: dir,
        killSwitchPath: path.join(dir, "kill.switch"),
      };
      const router = new ExecutionRouter(env, cfg);
      await assert.rejects(
        () =>
          router.buy("solana", {
            sellToken: "So11111111111111111111111111111111111111112",
            buyToken: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
            sellUsd: 2,
            slippageBps: 300,
            dryRun: false,
          }),
        /DRY_RUN guard/,
      );
      assert.equal(signed, 0);
      assert.equal(executed, 0);
    } finally {
      VersionedTransaction.prototype.sign = sign;
      globalThis.fetch = originalFetch;
      if (prev === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = prev;
    }
  });
});
