/** Shared domain types for the copy bot. */

export type ChainName =
  | "solana"
  | "base"
  | "robinhood"
  | "bsc"
  | "ethereum"
  | "arc"
  | "monad"
  | "hyperliquid"
  | "unknown";

export type AlertSide = "buy" | "sell" | "thesis" | "transfer" | "other";

/**
 * Normalized alert used by the copy engine.
 * Produced only by `fomo/adapter.ts` from raw FOMO WS/REST payloads.
 */
export interface NormalizedAlert {
  eventId: string;
  alertType: AlertSide;
  source: string;
  userId: string | null;
  tradeId: string | null;
  swapId: string | null;
  traderHandle: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  chain: ChainName;
  chainId: number | null;
  /** Fill size in USD when FOMO supplies tradeUsd; null if unknown. */
  tradeUsd: number | null;
  /** Legacy/position mark — do NOT treat as fill size when tradeUsd is null. */
  usdValue: number | null;
  positionValueUsd: number | null;
  text: string | null;
  ts: number | null;
  txHash: string | null;
  marketCapUsd: number | null;
  raw: unknown;
}

export interface TraderConfig {
  handle?: string;
  userId?: string;
  enabled: boolean;
  chains: ChainName[];
}

/** FOMO GET /v2/leaderboard/{window} path values from docs. */
export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";

export type TraderSource = "leaderboard" | "manual";

export type SizingMode = "fixed_usd" | "percent_of_trader";

export interface AppConfig {
  /** Default: leaderboard (top N on weekly board). */
  traderSource: TraderSource;
  leaderboard: {
    /** Exact FOMO window: 24h | 7d | 30d | all. Weekly = 7d. */
    window: LeaderboardWindow;
    topN: number;
    refreshHours: number;
  };
  /** Used when traderSource=manual. Ignored for entries when leaderboard mode. */
  traders: TraderConfig[];
  chains: { solana: boolean; base: boolean };
  sizing: {
    mode: SizingMode;
    fixedUsd: number;
    percentOfTrader: number;
    maxUsdPerTrade: number;
    minTraderTradeUsd: number;
  };
  filters: {
    marketCapMinUsd: number;
    marketCapMaxUsd: number;
    firstBuysOnly: boolean;
    allowedChains: ChainName[];
    /** Solana mint safety: block | warn | off (default block). */
    tokenSafety: "block" | "warn" | "off";
    blockFreezeAuthority: boolean;
    blockTransferHooks: boolean;
  };
  risk: {
    takeProfitPct: number;
    stopLossPct: number;
    maxSlippageBps: number;
    maxChaseBps: number;
    dailyBudgetUsd: number;
    maxOpenPositions: number;
    cooldownSeconds: number;
    copySells: boolean;
    /** Simulate Jupiter TX via RPC before signing (live only). Default true. */
    simulateBeforeSign: boolean;
    /** Extra lamports tolerated beyond expected SOL input / fees. Default 50000. */
    simMaxExtraLamports: number;
    /** Extra raw token units tolerated on input ATA outflow. Default 0. */
    simMaxExtraTokenOutflow: number;
  };
  quote: {
    solanaNative: string;
    baseNative: string;
    preferStableBuys: boolean;
    solanaStable: string;
    baseStable: string;
  };
  poll: {
    alertsRestEnabled: boolean;
    alertsRestIntervalSec: number;
    tpSlCheckIntervalSec: number;
  };
  logging: { level: "debug" | "info" | "warn" | "error" };
}

export interface OpenPosition {
  id: string;
  traderUserId: string | null;
  traderHandle: string | null;
  tradeId: string | null;
  chain: ChainName;
  tokenAddress: string;
  tokenSymbol: string | null;
  entryUsd: number;
  sizeUsd: number;
  /** Remaining size in USD cost basis (reduced on partial sells). */
  remainingUsd: number;
  quantityRaw: string | null;
  entryPriceUsd: number | null;
  /** Trader's fill/position USD at our entry — used for proportional sells. */
  traderSizeAtEntryUsd: number | null;
  /** Trader's FOMO position token amount at our entry (for delta-based sells). */
  traderTokenAmountAtEntry: number | null;
  openedAt: string;
  sourceEventId: string;
  /** open | closing (locked) | closed | dry_open | dry_closed */
  status: "open" | "closing" | "closed" | "dry_open" | "dry_closed";
  isDryRun: boolean;
  closedAt?: string;
  exitUsd?: number;
  exitReason?: string;
  realizedPnlUsd?: number;
  txEntry?: string | null;
  txExit?: string | null;
}

export interface DailyStats {
  date: string;
  spentUsd: number;
  realizedPnlUsd: number;
  trades: number;
}

export type SkipReason =
  | "kill_switch"
  | "dry_run_log_only"
  | "unsupported_chain"
  | "trader_not_watched"
  | "trader_inactive_alumni"
  | "chain_disabled_for_trader"
  | "below_min_trader_size"
  | "above_max_trade"
  | "daily_budget"
  | "max_positions"
  | "cooldown"
  | "first_buys_only"
  | "market_cap"
  | "no_token_address"
  | "invalid_token_address"
  | "token_safety"
  | "sell_without_our_position"
  | "already_processed"
  | "sizing_unknown"
  | "quote_failed"
  | "chase_limit"
  | "execution_failed"
  | "paused"
  | "other";
