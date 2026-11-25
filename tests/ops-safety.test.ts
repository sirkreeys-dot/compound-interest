import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slippageDriftBps } from "../src/ops/drift.js";
import { walletExceedsCeiling } from "../src/ops/wallet.js";
import { withRpcFailover } from "../src/utils/http.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import type { NormalizedAlert } from "../src/types.js";

describe("operational helpers", () => {
  it("slippage drift is measurable", () => {
    assert.equal(slippageDriftBps(2, 1.9), -500);
    assert.equal(slippageDriftBps(2, 2), 0);
    assert.equal(slippageDriftBps(0, 2), null);
  });

  it("wallet ceiling compares lamports only", () => {
    assert.equal(walletExceedsCeiling(1_000_000_000, 1), false);
    assert.equal(walletExceedsCeiling(1_000_000_001, 1), true);
    assert.equal(walletExceedsCeiling(500_000_000, 1), false);
  });

  it("RPC failover tries the secondary once and stops", async () => {
    const seen: string[] = [];
    const value = await withRpcFailover(["https://primary.example", "https://secondary.example"], async (url) => {
      seen.push(url);
      if (seen.length === 1) throw new Error("429");
      return "ok";
    });
    assert.equal(value, "ok");
    assert.deepEqual(seen, ["https://primary.example", "https://secondary.example"]);
    await assert.rejects(
      withRpcFailover(["https://a.example", "https://b.example"], async () => {
        throw new Error("down");
      }),
      /down/,
    );
  });

  it("telegram alert text redacts secrets before send", async () => {
    const bodies: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const tg = new TelegramNotifier("123456:abcdefghijklmnopqrstuvwxyz0123456789", "1");
      const alert: NormalizedAlert = {
        eventId: "e",
        alertType: "buy",
        source: "feed",
        userId: null,
        tradeId: null,
        swapId: null,
        traderHandle: "alpha",
        tokenSymbol: "TOK",
        tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
        chain: "solana",
        chainId: null,
        tradeUsd: 2,
        usdValue: null,
        positionValueUsd: null,
        text: null,
        ts: null,
        txHash: null,
        marketCapUsd: null,
        raw: {},
      };
      await tg.notifySkip(
        alert,
        "execution_failed",
        "rpc https://solana-mainnet.g.alchemy.com/v2/" +
          "THISISASECRETKEY SOLANA_PRIVATE_KEY=" +
          "supersecretvalue fapi_" +
          "livekeyvalue",
      );
      assert.equal(bodies.length, 1);
      assert.doesNotMatch(bodies[0]!, /THISISASECRETKEY/);
      assert.doesNotMatch(bodies[0]!, /supersecretvalue/);
      assert.doesNotMatch(bodies[0]!, new RegExp("fapi_" + "livekeyvalue"));
      assert.match(bodies[0]!, /REDACTED/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
