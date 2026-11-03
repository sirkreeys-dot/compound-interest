import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriceService } from "../src/utils/prices.js";
import { resolveSellFraction, findTraderTokenAmount } from "../src/engine/sellFraction.js";
import type { OpenPosition } from "../src/types.js";
import { ZEROX_NATIVE_ETH } from "../src/utils/money.js";

function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    return handler(url);
  }) as typeof fetch;
}

describe("open-issue: fresh prices prefer Jupiter/0x over CoinGecko", () => {
  it("uses Jupiter price v3 for SOL", async () => {
    const ps = new PriceService({
      fetchImpl: mockFetch((url) => {
        if (url.includes("api.jup.ag/price/v3")) {
          return new Response(
            JSON.stringify({
              So11111111111111111111111111111111111111112: {
                usdPrice: 150.5,
                blockId: 1,
                decimals: 9,
              },
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 500 });
      }),
    });
    const p = await ps.getSolUsd();
    assert.equal(p.source, "jupiter_v3");
    assert.equal(p.usd, 150.5);
  });

  it("refuses CoinGecko outside sanity bounds", async () => {
    const ps = new PriceService({
      fetchImpl: mockFetch((url) => {
        if (url.includes("jup.ag")) return new Response("{}", { status: 500 });
        if (url.includes("coingecko")) {
          return new Response(JSON.stringify({ solana: { usd: 0.01 } }), { status: 200 });
        }
        return new Response("{}", { status: 500 });
      }),
    });
    await assert.rejects(() => ps.getSolUsd(), /No fresh SOL/);
  });

  it("rawOutToUsd uses fresh SOL price when quote lacks outUsdValue", async () => {
    const ps = new PriceService({
      fetchImpl: mockFetch((url) => {
        if (url.includes("price/v3")) {
          return new Response(
            JSON.stringify({
              So11111111111111111111111111111111111111112: {
                usdPrice: 100,
                blockId: 2,
                decimals: 9,
              },
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 500 });
      }),
    });
    const v = await ps.rawOutToUsd({
      chain: "solana",
      buyToken: "So11111111111111111111111111111111111111112",
      outAmountRaw: "1000000000", // 1 SOL
    });
    assert.ok(v);
    assert.equal(v!.usd, 100);
  });

  it("0x price path for ETH when key present", async () => {
    const ps = new PriceService({
      zeroXApiKey: "test-key",
      fetchImpl: mockFetch((url) => {
        if (url.includes("allowance-holder/price")) {
          return new Response(JSON.stringify({ buyAmount: "3500000000" }), { status: 200 }); // $3500
        }
        return new Response("{}", { status: 500 });
      }),
    });
    const p = await ps.getEthUsd();
    assert.equal(p.source, "zerox_price");
    assert.equal(p.usd, 3500);
  });
});

describe("open-issue: FOMO-based sell fraction", () => {
  const basePos: OpenPosition = {
    id: "1",
    traderUserId: "u1",
    traderHandle: "alpha",
    tradeId: null,
    chain: "solana",
    tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
    tokenSymbol: "TOK",
    entryUsd: 2,
    sizeUsd: 2,
    remainingUsd: 2,
    quantityRaw: "1000",
    entryPriceUsd: null,
    traderSizeAtEntryUsd: 1000,
    traderTokenAmountAtEntry: 100,
    openedAt: new Date().toISOString(),
    sourceEventId: "e",
    status: "open",
    isDryRun: true,
  };

  it("findTraderTokenAmount reads documented positions shape", () => {
    const amt = findTraderTokenAmount(
      {
        positions: [
          { token: { address: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP", symbol: "TOK" }, status: "open", amount: 42 },
        ],
      },
      "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
    );
    assert.equal(amt, 42);
  });

  it("uses fomo_position_delta when entry amount known", async () => {
    const fomo = {
      positions: async () => ({
        positions: [
          {
            token: { address: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP" },
            status: "open",
            amount: 75, // sold 25 of 100
          },
        ],
      }),
    };
    const r = await resolveSellFraction({
      pos: basePos,
      alert: {
        eventId: "s",
        alertType: "sell",
        source: "feed",
        userId: "u1",
        tradeId: null,
        swapId: null,
        traderHandle: "alpha",
        tokenSymbol: "TOK",
        tokenAddress: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP",
        chain: "solana",
        chainId: null,
        tradeUsd: null,
        usdValue: null,
        positionValueUsd: null,
        text: null,
        ts: null,
        txHash: null,
        marketCapUsd: null,
        raw: {},
      },
      fomo: fomo as never,
    });
    assert.equal(r.method, "fomo_position_delta");
    assert.equal(r.fraction, 0.25);
  });

  it("full exit when FOMO shows closed / zero amount", async () => {
    const fomo = {
      positions: async () => ({
        positions: [{ token: { address: "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP" }, status: "closed", amount: 0 }],
      }),
    };
    const r = await resolveSellFraction({ pos: basePos, fomo: fomo as never });
    assert.equal(r.method, "fomo_fully_closed");
    assert.equal(r.fraction, 1);
  });

  it("falls back to full_exit_fallback when nothing reliable", async () => {
    const r = await resolveSellFraction({
      pos: { ...basePos, traderTokenAmountAtEntry: null, traderSizeAtEntryUsd: null },
      fomo: null,
      alert: undefined,
    });
    assert.equal(r.method, "full_exit_fallback");
    assert.equal(r.fraction, 1);
  });
});

describe("open-issue: native sentinel constant", () => {
  it("0x native ETH sentinel is documented shape", () => {
    assert.equal(ZEROX_NATIVE_ETH.toLowerCase(), "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  });
});
