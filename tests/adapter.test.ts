import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapAlertType, parseAlert, parseAlertsRestBody, resolveChain } from "../src/fomo/adapter.js";

describe("adapter.parseAlert", () => {
  it("parses documented buy alert fields", () => {
    const n = parseAlert({
      type: "alert",
      alertType: "buy",
      source: "feed",
      eventId: "149318d0-70af-4acb-a607-b126dd4db4a3",
      userId: "6dcf7c78-2537-522a-8307-3f9970c081be",
      tradeId: "a323b5ca-c769-4b07-a422-833c4cafbe1f",
      swapId: null,
      trader: "frankdegods",
      token: "PONS",
      tokenAddress: "0x39dbed3a...",
      chainId: 4663,
      chain: "robinhood",
      usdValue: 4000,
      positionValueUsd: 4000,
      tradeUsd: 3500,
      text: "frankdegods bought $PONS ($4K size)",
      ts: 1788378000000,
    });
    assert.ok(n);
    assert.equal(n!.alertType, "buy");
    assert.equal(n!.traderHandle, "frankdegods");
    assert.equal(n!.chain, "robinhood");
    assert.equal(n!.tradeUsd, 3500);
    assert.equal(n!.usdValue, 4000);
    assert.equal(n!.eventId, "149318d0-70af-4acb-a607-b126dd4db4a3");
  });

  it("does not invent tradeUsd from usdValue", () => {
    const n = parseAlert({
      type: "alert",
      alertType: "buy",
      eventId: "e1",
      trader: "x",
      token: "T",
      tokenAddress: "addr",
      chain: "solana",
      usdValue: 999,
    });
    assert.equal(n!.tradeUsd, null);
    assert.equal(n!.usdValue, 999);
  });

  it("ignores welcome messages", () => {
    assert.equal(parseAlert({ type: "welcome", realtime: true }), null);
  });

  it("maps chain ids", () => {
    assert.equal(resolveChain({ chainId: 8453 }).chain, "base");
    assert.equal(resolveChain({ chain: "solana" }).chain, "solana");
  });

  it("mapAlertType", () => {
    assert.equal(mapAlertType("buy"), "buy");
    assert.equal(mapAlertType("LARGE_BUY"), "buy");
    assert.equal(mapAlertType("milestone"), "other");
  });

  it("parseAlertsRestBody accepts alerts envelope", () => {
    const list = parseAlertsRestBody({
      alerts: [{ type: "alert", alertType: "sell", eventId: "s1", chain: "base", tokenAddress: "0x1" }],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.alertType, "sell");
  });
});
