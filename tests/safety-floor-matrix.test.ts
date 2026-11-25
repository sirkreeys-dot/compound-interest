import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLiveSafety, loadAppConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

type Case = {
  field: string;
  weaken: (cfg: AppConfig) => void;
};

const cases: Case[] = [
  { field: "minLiquidityUsd", weaken: (c) => (c.filters.minLiquidityUsd = 0) },
  { field: "maxTopHolderBps", weaken: (c) => (c.filters.maxTopHolderBps = 0) },
  { field: "maxTopHolderBps", weaken: (c) => (c.filters.maxTopHolderBps = 10000) },
  { field: "roundTripMaxLossBps", weaken: (c) => (c.filters.roundTripMaxLossBps = 0) },
  { field: "roundTripMaxLossBps", weaken: (c) => (c.filters.roundTripMaxLossBps = 2501) },
  { field: "tokenSafety", weaken: (c) => (c.filters.tokenSafety = "off") },
  { field: "tokenSafety", weaken: (c) => (c.filters.tokenSafety = "warn") },
  { field: "blockMintAuthority", weaken: (c) => (c.filters.blockMintAuthority = false) },
  { field: "blockFreezeAuthority", weaken: (c) => (c.filters.blockFreezeAuthority = false) },
  { field: "blockTransferHooks", weaken: (c) => (c.filters.blockTransferHooks = false) },
  { field: "maxTransferFeeBps", weaken: (c) => (c.filters.maxTransferFeeBps = 0) },
  { field: "maxTransferFeeBps", weaken: (c) => (c.filters.maxTransferFeeBps = 5000) },
  { field: "minPairAgeSec", weaken: (c) => (c.filters.minPairAgeSec = 0) },
  { field: "fakeLiquidityImpactBps", weaken: (c) => (c.filters.fakeLiquidityImpactBps = 5000) },
  { field: "simulateBeforeSign", weaken: (c) => (c.risk.simulateBeforeSign = false) },
  { field: "stopLossPct", weaken: (c) => (c.risk.stopLossPct = 0) },
  { field: "stopLossPct", weaken: (c) => (c.risk.stopLossPct = 50) },
  { field: "trailingStopPct", weaken: (c) => (c.risk.trailingStopPct = 0) },
  { field: "trailingStopPct", weaken: (c) => (c.risk.trailingStopPct = 40) },
  { field: "maxSlippageBps", weaken: (c) => (c.risk.maxSlippageBps = 1000) },
  { field: "sellSlippageBps", weaken: (c) => (c.risk.sellSlippageBps = [300, 1000, 5000]) },
  { field: "maxChaseBps", weaken: (c) => (c.risk.maxChaseBps = 0) },
  { field: "maxChaseBps", weaken: (c) => (c.risk.maxChaseBps = 2000) },
  { field: "simMaxOverheadLamports", weaken: (c) => (c.risk.simMaxOverheadLamports = 0) },
  { field: "simMaxOverheadLamports", weaken: (c) => (c.risk.simMaxOverheadLamports = 10_000_001) },
  { field: "simMaxExtraLamports", weaken: (c) => (c.risk.simMaxExtraLamports = 100_000) },
  { field: "simMaxFeeLamports", weaken: (c) => (c.risk.simMaxFeeLamports = 2_000_000) },
  { field: "simMaxExtraTokenOutflow", weaken: (c) => (c.risk.simMaxExtraTokenOutflow = 1) },
  { field: "maxUsdPerTrade", weaken: (c) => (c.sizing.maxUsdPerTrade = 6) },
  { field: "dailyBudgetUsd", weaken: (c) => (c.risk.dailyBudgetUsd = 41) },
  { field: "dailyLossLimitUsd", weaken: (c) => (c.risk.dailyLossLimitUsd = 0) },
  { field: "dailyLossLimitUsd", weaken: (c) => (c.risk.dailyLossLimitUsd = 21) },
  { field: "autoDropNegativePnl", weaken: (c) => (c.leaderboard.autoDropNegativePnl = false) },
  { field: "autoDropMinCloses", weaken: (c) => (c.leaderboard.autoDropMinCloses = 4) },
  { field: "quoteFailWriteoffCount", weaken: (c) => (c.risk.quoteFailWriteoffCount = 6) },
  { field: "copySells", weaken: (c) => (c.risk.copySells = false) },
  { field: "closeEmptyTokenAccount", weaken: (c) => (c.risk.closeEmptyTokenAccount = false) },
  { field: "maxConsecutiveFailures", weaken: (c) => (c.risk.maxConsecutiveFailures = 0) },
  { field: "maxConsecutiveFailures", weaken: (c) => (c.risk.maxConsecutiveFailures = 4) },
  { field: "maxWalletSol", weaken: (c) => (c.risk.maxWalletSol = 2) },
  { field: "inUsdToleranceBps", weaken: (c) => (c.risk.inUsdToleranceBps = 500) },
  { field: "solPriceDivergenceBps", weaken: (c) => (c.risk.solPriceDivergenceBps = 0) },
  { field: "solPriceDivergenceBps", weaken: (c) => (c.risk.solPriceDivergenceBps = 251) },
  { field: "solanaProgramAllowlist", weaken: (c) => (c.risk.solanaProgramAllowlist = []) },
  { field: "cooldownSeconds", weaken: (c) => (c.risk.cooldownSeconds = 0) },
  { field: "maxOpenPositions", weaken: (c) => (c.risk.maxOpenPositions = 11) },
];

describe("live safety floor, one field at a time", () => {
  it(`refuses each weakened field (${cases.length} cases)`, () => {
    const base = loadAppConfig(path.join(root, "config.example.yaml"));
    assert.doesNotThrow(() => assertLiveSafety(base));
    const fields = new Set<string>();
    for (const entry of cases) {
      const cfg = structuredClone(base);
      entry.weaken(cfg);
      assert.throws(() => assertLiveSafety(cfg), /LIVE refused/, entry.field);
      const message = (() => {
        try {
          assertLiveSafety(cfg);
          return "";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      })();
      assert.match(message, new RegExp(entry.field), message);
      fields.add(entry.field);
    }
    assert.equal(fields.size, 35);
    assert.equal(cases.length, 46);
  });

  it("accepts fixedUsd 1 without weakening the floor", () => {
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.sizing.fixedUsd = 1;
    assert.doesNotThrow(() => assertLiveSafety(cfg));
  });
});
