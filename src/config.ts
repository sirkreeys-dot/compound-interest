import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import yaml from "js-yaml";
import { z } from "zod";
import { OVERHEAD_HARD_CAP_LAMPORTS } from "./security/overhead.js";
import { DEFAULT_SOLANA_PROGRAM_ALLOWLIST } from "./security/programAllowlist.js";
import type { AppConfig, LeaderboardWindow, TraderSource } from "./types.js";
import { log } from "./utils/logger.js";

dotenv.config();

const chainSchema = z.enum([
  "solana",
  "base",
  "robinhood",
  "bsc",
  "ethereum",
  "arc",
  "monad",
  "hyperliquid",
  "unknown",
]);

const windowSchema = z.enum(["24h", "7d", "30d", "all"]);

const configSchema = z.object({
  traderSource: z.enum(["leaderboard", "manual"]).default("leaderboard"),
  leaderboard: z
    .object({
      window: windowSchema.default("30d"),
      topN: z.number().int().positive().default(3),
      refreshHours: z.number().positive().default(6),
      minTrades: z.number().int().nonnegative().default(0),
      autoDropNegativePnl: z.boolean().default(true),
      autoDropMinCloses: z.number().int().positive().default(3),
    })
    .default({
      window: "30d",
      topN: 3,
      refreshHours: 6,
      minTrades: 0,
      autoDropNegativePnl: true,
      autoDropMinCloses: 3,
    }),
  traders: z
    .array(
      z.object({
        handle: z.string().optional(),
        userId: z.string().optional(),
        enabled: z.boolean().default(true),
        chains: z.array(chainSchema).default(["solana"]),
      }),
    )
    .default([]),
  chains: z.object({
    solana: z.boolean().default(true),
    base: z.boolean().default(false),
  }),
  sizing: z.object({
    mode: z.enum(["fixed_usd", "percent_of_trader"]).default("fixed_usd"),
    fixedUsd: z.number().positive().default(2),
    percentOfTrader: z.number().positive().default(10),
    maxUsdPerTrade: z.number().positive().default(5),
    minTraderTradeUsd: z.number().nonnegative().default(0),
    mergeRebuys: z.boolean().default(true),
    maxUsdPerToken: z.number().nonnegative().default(5),
  }),
  filters: z.object({
    marketCapMinUsd: z.number().nonnegative().default(0),
    marketCapMaxUsd: z.number().nonnegative().default(0),
    firstBuysOnly: z.boolean().default(false),
    allowedChains: z.array(chainSchema).default(["solana"]),
    tokenSafety: z.enum(["block", "warn", "off"]).default("block"),
    blockFreezeAuthority: z.boolean().default(true),
    blockTransferHooks: z.boolean().default(true),
    blockMintAuthority: z.boolean().default(true),
    maxTopHolderBps: z.number().int().nonnegative().default(9000),
    roundTripMaxLossBps: z.number().int().nonnegative().default(2500),
    minLiquidityUsd: z.number().nonnegative().default(10_000),
    /** Token-2022 transfer fee above this bps fails closed. */
    maxTransferFeeBps: z.number().int().nonnegative().default(100),
    /** Pools younger than this are treated as fake liquidity. 0 disables the age check. */
    minPairAgeSec: z.number().int().nonnegative().default(1800),
    /** Sell impact above this, while DexScreener liquidity clears the floor, is fake depth. */
    fakeLiquidityImpactBps: z.number().int().nonnegative().default(1000),
  }),
  risk: z.object({
    trailingStopPct: z.number().nonnegative().default(20),
    stopLossPct: z.number().nonnegative().default(25),
    maxHoldMinutes: z.number().int().nonnegative().default(0),
    maxSlippageBps: z.number().int().positive().default(300),
    sellSlippageBps: z.array(z.number().int().positive()).min(1).default([300, 1000, 2500]),
    maxChaseBps: z.number().int().nonnegative().default(500),
    dailyBudgetUsd: z.number().positive().default(40),
    dailyLossLimitUsd: z.number().nonnegative().default(20),
    maxOpenPositions: z.number().int().positive().default(10),
    cooldownSeconds: z.number().int().nonnegative().default(30),
    copySells: z.boolean().default(true),
    simulateBeforeSign: z.boolean().default(true),
    simMaxExtraLamports: z.number().int().nonnegative().default(50_000),
    simMaxFeeLamports: z.number().int().nonnegative().default(1_000_000),
    simMaxOverheadLamports: z
      .number()
      .int()
      .min(1)
      .max(Number(OVERHEAD_HARD_CAP_LAMPORTS))
      .default(5_000_000),
    simMaxExtraTokenOutflow: z.number().int().nonnegative().default(0),
    closeEmptyTokenAccount: z.boolean().default(true),
    quoteFailWriteoffCount: z.number().int().positive().default(5),
    mirroredSellMaxRetries: z.number().int().positive().default(4),
    /** Jupiter inUsdValue may exceed maxUsdPerTrade by this many bps (fees). */
    inUsdToleranceBps: z.number().int().nonnegative().default(200),
    /** Two SOL/USD sources may differ by at most this many bps. */
    solPriceDivergenceBps: z.number().int().nonnegative().default(250),
    /** Top-level programs a signed Jupiter tx may call. */
    solanaProgramAllowlist: z.array(z.string().min(32)).default(DEFAULT_SOLANA_PROGRAM_ALLOWLIST),
    maxConsecutiveFailures: z.number().int().nonnegative().default(3),
    maxWalletSol: z.number().positive().default(1),
    jupiterMaxRequestsPerSec: z.number().positive().max(10).default(2),
  }),
  quote: z.object({
    solanaNative: z.string(),
    baseNative: z.string(),
    preferStableBuys: z.boolean().default(false),
    solanaStable: z.string(),
    baseStable: z.string(),
  }),
  poll: z.object({
    alertsRestEnabled: z.boolean().default(true),
    alertsRestOnlyWhenWsDown: z.boolean().default(true),
    alertsRestIntervalSec: z.number().int().positive().default(90),
    tpSlCheckIntervalSec: z.number().int().positive().default(15),
    positionReconcileIntervalSec: z.number().int().nonnegative().default(10_800),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
});

export interface EnvConfig {
  fomoApiKey: string;
  dryRun: boolean;
  solanaRpcUrl: string;
  solanaPrivateKey: string;
  jupiterApiKey: string;
  baseRpcUrl: string;
  basePrivateKey: string;
  zeroXApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  /** When non-empty, Telegram commands require from.id in this list (in addition to chat id). */
  telegramAllowedUserIds: string[];
  configPath: string;
  dataDir: string;
  killSwitchPath: string;
  /**
   * Public Solana address used as Jupiter taker during DRY_RUN so the sell
   * simulation can be built without a private key. Empty means that simulation
   * is skipped (labeled dryRunSellSim=no_public_key).
   */
  dryRunSolanaPubkey?: string;
  /** Second RPC used after the primary fails. Never logged. */
  solanaRpcUrlSecondary?: string;
  /**
   * When true, a loopback RPC is a real solana-test-validator and may be
   * simulated and signed against. Default false: loopback fails closed.
   */
  solanaAllowLoopback?: boolean;
  /** Optional env overrides for watchlist (applied after yaml). */
  traderSource?: TraderSource;
  leaderboardWindow?: LeaderboardWindow;
  leaderboardTopN?: number;
  leaderboardRefreshHours?: number;
  /** Comma-separated: solana, base. Overrides chains.* and filters.allowedChains. */
  enabledChains?: Array<"solana" | "base">;
}

function envBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function parseWindow(v: string | undefined): LeaderboardWindow | undefined {
  if (!v) return undefined;
  const raw = v.trim().toLowerCase();
  // Accept friendly aliases; FOMO API path uses 7d for weekly
  if (raw === "weekly" || raw === "week" || raw === "7d") return "7d";
  if (raw === "daily" || raw === "day" || raw === "24h") return "24h";
  if (raw === "monthly" || raw === "month" || raw === "30d") return "30d";
  if (raw === "all" || raw === "all-time" || raw === "alltime") return "all";
  if (raw === "24h" || raw === "7d" || raw === "30d" || raw === "all") {
    return raw;
  }
  throw new Error(
    `Invalid LEADERBOARD_WINDOW=${v}. Use FOMO values: 24h | 7d | 30d | all (weekly → 7d)`,
  );
}

function parseEnabledChains(v: string | undefined): Array<"solana" | "base"> | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const parts = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: Array<"solana" | "base"> = [];
  for (const p of parts) {
    if (p === "solana" || p === "base") {
      if (!out.includes(p)) out.push(p);
    } else {
      throw new Error(
        `Invalid ENABLED_CHAINS entry "${p}". Allowed: solana, base (comma-separated).`,
      );
    }
  }
  if (!out.length) {
    throw new Error("ENABLED_CHAINS is empty after parsing");
  }
  return out;
}

export function loadEnv(): EnvConfig {
  const topN = process.env.LEADERBOARD_TOP_N?.trim();
  const refresh = process.env.LEADERBOARD_REFRESH_HOURS?.trim();
  const source = process.env.TRADER_SOURCE?.trim().toLowerCase();
  return {
    fomoApiKey: process.env.FOMO_API_KEY?.trim() ?? "",
    dryRun: envBool(process.env.DRY_RUN, true),
    solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    solanaRpcUrlSecondary: process.env.SOLANA_RPC_URL_SECONDARY?.trim() || undefined,
    solanaAllowLoopback: envBool(process.env.SOLANA_ALLOW_LOOPBACK, false),
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY?.trim() ?? "",
    jupiterApiKey: process.env.JUPITER_API_KEY?.trim() ?? "",
    baseRpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    basePrivateKey: process.env.BASE_PRIVATE_KEY?.trim() ?? "",
    zeroXApiKey: process.env.ZEROX_API_KEY?.trim() ?? "",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
    telegramAllowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    configPath: process.env.CONFIG_PATH ?? "./config.yaml",
    dataDir: process.env.DATA_DIR ?? "./data",
    killSwitchPath: process.env.KILL_SWITCH_PATH ?? "./kill.switch",
    dryRunSolanaPubkey: process.env.DRY_RUN_SOLANA_PUBKEY?.trim() || undefined,
    traderSource:
      source === "manual" || source === "leaderboard" ? source : undefined,
    leaderboardWindow: parseWindow(process.env.LEADERBOARD_WINDOW),
    leaderboardTopN: topN ? Number(topN) : undefined,
    leaderboardRefreshHours: refresh ? Number(refresh) : undefined,
    enabledChains: parseEnabledChains(process.env.ENABLED_CHAINS),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Arrays and scalars from the overlay replace the base. Missing keys stay on the base. */
export function deepMergeConfig(base: unknown, overlay: unknown): unknown {
  if (Array.isArray(overlay)) return overlay.slice();
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue;
      out[key] = key in base ? deepMergeConfig(base[key], value) : value;
    }
    return out;
  }
  return overlay;
}

export function exampleConfigPath(): string {
  const candidates = [
    path.resolve("config.example.yaml"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config.example.yaml"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config.example.yaml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("config.example.yaml not found");
}

/**
 * Settings weaker than the committed rules. A smaller trade size is not weaker.
 * Stricter liquidity, holder, round-trip, or stop-loss values are not weaker.
 */
export function weakenedSafetySettings(cfg: AppConfig): string[] {
  const weakened: string[] = [];
  if (cfg.filters.minLiquidityUsd < 10_000) {
    weakened.push(`minLiquidityUsd ${cfg.filters.minLiquidityUsd} < 10000`);
  }
  if (!(cfg.filters.maxTopHolderBps > 0) || cfg.filters.maxTopHolderBps > 9000) {
    weakened.push(`maxTopHolderBps ${cfg.filters.maxTopHolderBps} outside 1..9000`);
  }
  if (!(cfg.filters.roundTripMaxLossBps > 0) || cfg.filters.roundTripMaxLossBps > 2500) {
    weakened.push(`roundTripMaxLossBps ${cfg.filters.roundTripMaxLossBps} outside 1..2500`);
  }
  if (cfg.filters.tokenSafety !== "block") {
    weakened.push(`tokenSafety ${cfg.filters.tokenSafety} is not block`);
  }
  if (!cfg.filters.blockMintAuthority) weakened.push("blockMintAuthority is off");
  if (!cfg.filters.blockFreezeAuthority) weakened.push("blockFreezeAuthority is off");
  if (!cfg.risk.simulateBeforeSign) weakened.push("simulateBeforeSign is off");
  if (cfg.risk.simMaxOverheadLamports < 1 || cfg.risk.simMaxOverheadLamports > 10_000_000) {
    weakened.push(`simMaxOverheadLamports ${cfg.risk.simMaxOverheadLamports} outside 1..10000000`);
  }
  if (!(cfg.risk.stopLossPct > 0) || cfg.risk.stopLossPct > 25) {
    weakened.push(`stopLossPct ${cfg.risk.stopLossPct} outside 1..25`);
  }
  if (cfg.sizing.maxUsdPerTrade > 5) {
    weakened.push(`maxUsdPerTrade ${cfg.sizing.maxUsdPerTrade} > 5`);
  }
  if (cfg.risk.dailyBudgetUsd > 40) {
    weakened.push(`dailyBudgetUsd ${cfg.risk.dailyBudgetUsd} > 40`);
  }
  if (!(cfg.risk.dailyLossLimitUsd > 0) || cfg.risk.dailyLossLimitUsd > 20) {
    weakened.push(`dailyLossLimitUsd ${cfg.risk.dailyLossLimitUsd} outside 0.01..20`);
  }
  if (!(cfg.risk.maxSlippageBps > 0) || cfg.risk.maxSlippageBps > 300) {
    weakened.push(`maxSlippageBps ${cfg.risk.maxSlippageBps} outside 1..300`);
  }
  const ladder = cfg.risk.sellSlippageBps ?? [];
  if (!ladder.length || ladder.some((bps) => bps > 2500)) {
    weakened.push(`sellSlippageBps ${ladder.join(",")} has a rung above 2500`);
  }
  if (!(cfg.risk.trailingStopPct > 0) || cfg.risk.trailingStopPct > 20) {
    weakened.push(`trailingStopPct ${cfg.risk.trailingStopPct} outside 1..20`);
  }
  if (!cfg.filters.blockTransferHooks) weakened.push("blockTransferHooks is off");
  if (!(cfg.filters.maxTransferFeeBps > 0) || cfg.filters.maxTransferFeeBps > 100) {
    weakened.push(`maxTransferFeeBps ${cfg.filters.maxTransferFeeBps} outside 1..100`);
  }
  if (!(cfg.filters.minPairAgeSec > 0)) {
    weakened.push(`minPairAgeSec ${cfg.filters.minPairAgeSec} disables the age check`);
  }
  if (!(cfg.risk.maxChaseBps > 0) || cfg.risk.maxChaseBps > 500) {
    weakened.push(`maxChaseBps ${cfg.risk.maxChaseBps} outside 1..500`);
  }
  if (!(cfg.leaderboard.autoDropNegativePnl)) weakened.push("autoDropNegativePnl is off");
  if (cfg.leaderboard.autoDropMinCloses > 3) {
    weakened.push(`autoDropMinCloses ${cfg.leaderboard.autoDropMinCloses} > 3`);
  }
  if (cfg.risk.quoteFailWriteoffCount > 5) {
    weakened.push(`quoteFailWriteoffCount ${cfg.risk.quoteFailWriteoffCount} > 5`);
  }
  if (!cfg.risk.copySells) weakened.push("copySells is off");
  if (!cfg.risk.closeEmptyTokenAccount) weakened.push("closeEmptyTokenAccount is off");
  if ((cfg.risk.simMaxExtraTokenOutflow ?? 0) > 0) {
    weakened.push(`simMaxExtraTokenOutflow ${cfg.risk.simMaxExtraTokenOutflow} > 0`);
  }
  if (!(cfg.risk.maxConsecutiveFailures > 0) || cfg.risk.maxConsecutiveFailures > 3) {
    weakened.push(`maxConsecutiveFailures ${cfg.risk.maxConsecutiveFailures} outside 1..3`);
  }
  if (!(cfg.risk.maxWalletSol > 0) || cfg.risk.maxWalletSol > 1) {
    weakened.push(`maxWalletSol ${cfg.risk.maxWalletSol} > 1`);
  }
  if ((cfg.risk.solPriceDivergenceBps ?? 0) <= 0 || cfg.risk.solPriceDivergenceBps > 250) {
    weakened.push(`solPriceDivergenceBps ${cfg.risk.solPriceDivergenceBps} outside 1..250`);
  }
  if ((cfg.risk.inUsdToleranceBps ?? 0) > 200) {
    weakened.push(`inUsdToleranceBps ${cfg.risk.inUsdToleranceBps} > 200`);
  }
  if ((cfg.filters.fakeLiquidityImpactBps ?? 0) > 1000) {
    weakened.push(`fakeLiquidityImpactBps ${cfg.filters.fakeLiquidityImpactBps} > 1000`);
  }
  if ((cfg.risk.simMaxExtraLamports ?? 0) > 50_000) {
    weakened.push(`simMaxExtraLamports ${cfg.risk.simMaxExtraLamports} > 50000`);
  }
  if ((cfg.risk.simMaxFeeLamports ?? 0) > 1_000_000) {
    weakened.push(`simMaxFeeLamports ${cfg.risk.simMaxFeeLamports} > 1000000`);
  }
  if (!cfg.risk.solanaProgramAllowlist?.length) weakened.push("solanaProgramAllowlist is empty");
  if (cfg.risk.cooldownSeconds <= 0) weakened.push("cooldownSeconds is 0");
  if (cfg.risk.maxOpenPositions > 10) {
    weakened.push(`maxOpenPositions ${cfg.risk.maxOpenPositions} > 10`);
  }
  return weakened;
}

export function assertLiveSafety(cfg: AppConfig): void {
  const weakened = weakenedSafetySettings(cfg);
  if (weakened.length) {
    throw new Error(`LIVE refused: safety settings weaker than the committed floor: ${weakened.join("; ")}`);
  }
}

export function loadAppConfig(configPath: string, env?: EnvConfig): AppConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config not found: ${abs}. Copy config.example.yaml to config.yaml`);
  }
  const examplePath = exampleConfigPath();
  const overlay = yaml.load(fs.readFileSync(abs, "utf8"));
  const base = yaml.load(fs.readFileSync(examplePath, "utf8"));
  const raw =
    path.resolve(examplePath) === abs ? overlay : deepMergeConfig(base, overlay);
  const parsed = configSchema.parse(raw) as AppConfig;

  // Env overrides (TRADER_SOURCE, LEADERBOARD_*)
  if (env?.traderSource) parsed.traderSource = env.traderSource;
  if (env?.leaderboardWindow) parsed.leaderboard.window = env.leaderboardWindow;
  if (env?.leaderboardTopN && Number.isFinite(env.leaderboardTopN)) {
    parsed.leaderboard.topN = env.leaderboardTopN;
  }
  if (env?.leaderboardRefreshHours && Number.isFinite(env.leaderboardRefreshHours)) {
    parsed.leaderboard.refreshHours = env.leaderboardRefreshHours;
  }
  if (env?.enabledChains) {
    parsed.chains.solana = env.enabledChains.includes("solana");
    parsed.chains.base = env.enabledChains.includes("base");
    parsed.filters.allowedChains = [...env.enabledChains];
  }

  if (parsed.traderSource === "manual") {
    if (!parsed.traders.length) {
      throw new Error("traderSource=manual requires at least one entry in traders:");
    }
    for (const t of parsed.traders) {
      if (!t.handle && !t.userId) {
        throw new Error("Each manual trader needs handle and/or userId");
      }
    }
  }

  const weakened = weakenedSafetySettings(parsed);
  if (weakened.length) {
    const detail = weakened.join("; ");
    if (env?.dryRun === false) {
      throw new Error(`LIVE refused: safety settings weaker than the committed floor: ${detail}`);
    }
    log.warn(`DRY_RUN safety settings weaker than the committed floor: ${detail}`);
  } else if (env?.dryRun === false) {
    assertLiveSafety(parsed);
  }

  return parsed;
}

export function ensureDataDir(dir: string): void {
  fs.mkdirSync(path.resolve(dir), { recursive: true });
}
