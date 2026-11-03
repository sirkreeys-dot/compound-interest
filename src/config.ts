import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import yaml from "js-yaml";
import { z } from "zod";
import type { AppConfig, LeaderboardWindow, TraderSource } from "./types.js";

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
      window: windowSchema.default("7d"),
      topN: z.number().int().positive().default(3),
      refreshHours: z.number().positive().default(6),
    })
    .default({
      window: "7d",
      topN: 3,
      refreshHours: 6,
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
  }),
  filters: z.object({
    marketCapMinUsd: z.number().nonnegative().default(0),
    marketCapMaxUsd: z.number().nonnegative().default(0),
    firstBuysOnly: z.boolean().default(false),
    allowedChains: z.array(chainSchema).default(["solana"]),
    tokenSafety: z.enum(["block", "warn", "off"]).default("block"),
    blockFreezeAuthority: z.boolean().default(true),
    blockTransferHooks: z.boolean().default(true),
  }),
  risk: z.object({
    takeProfitPct: z.number().nonnegative().default(50),
    stopLossPct: z.number().nonnegative().default(25),
    maxSlippageBps: z.number().int().positive().default(300),
    maxChaseBps: z.number().int().nonnegative().default(500),
    dailyBudgetUsd: z.number().positive().default(40),
    maxOpenPositions: z.number().int().positive().default(10),
    cooldownSeconds: z.number().int().nonnegative().default(30),
    copySells: z.boolean().default(true),
    simulateBeforeSign: z.boolean().default(true),
    simMaxExtraLamports: z.number().int().nonnegative().default(50_000),
    simMaxExtraTokenOutflow: z.number().int().nonnegative().default(0),
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
    alertsRestIntervalSec: z.number().int().positive().default(20),
    tpSlCheckIntervalSec: z.number().int().positive().default(60),
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
    traderSource:
      source === "manual" || source === "leaderboard" ? source : undefined,
    leaderboardWindow: parseWindow(process.env.LEADERBOARD_WINDOW),
    leaderboardTopN: topN ? Number(topN) : undefined,
    leaderboardRefreshHours: refresh ? Number(refresh) : undefined,
    enabledChains: parseEnabledChains(process.env.ENABLED_CHAINS),
  };
}

export function loadAppConfig(configPath: string, env?: EnvConfig): AppConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config not found: ${abs}. Copy config.example.yaml to config.yaml`);
  }
  const raw = yaml.load(fs.readFileSync(abs, "utf8"));
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

  return parsed;
}

export function ensureDataDir(dir: string): void {
  fs.mkdirSync(path.resolve(dir), { recursive: true });
}
