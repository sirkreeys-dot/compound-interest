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
  /** Default: leaderboard (top N). */
  traderSource: TraderSource;
  leaderboard: {
    /** Exact FOMO window: 24h | 7d | 30d | all. Default 30d. */
    window: LeaderboardWindow;
    topN: number;
    refreshHours: number;
    /** Drop a leaderboard row when it exposes a trade count below this. 0 = off. */
    minTrades: number;
    /**
     * Stop new entries once our copied closes for that trader are net-negative
     * over autoDropMinCloses. Sells of bags already open still run.
     */
    autoDropNegativePnl: boolean;
    autoDropMinCloses: number;
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
    /** When true (and firstBuysOnly is false), later buys add to the open position. */
    mergeRebuys: boolean;
    /** Max cumulative open cost basis per token. 0 = no extra cap. */
    maxUsdPerToken: number;
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
    /** Block buys while the mint authority is still set. */
    blockMintAuthority: boolean;
    /** Block when the largest token account holds more than this share. 0 disables. */
    maxTopHolderBps: number;
    /** Block when a sell quote of the buy output loses more than this vs USD in. 0 disables. */
    roundTripMaxLossBps: number;
    /** Block when external liquidity is below this USD. 0 disables. Fail closed when enabled. */
    minLiquidityUsd: number;
    /** Block Token-2022 transfer fees above this many bps. */
    maxTransferFeeBps: number;
    /** Block pools younger than this. 0 disables. */
    minPairAgeSec: number;
    /** Block when a deep DexScreener pool still shows this much sell impact. */
    fakeLiquidityImpactBps: number;
  };
  risk: {
    /**
     * After the first partial mirrored sell, exit the remainder when mark falls
     * this percent from the highest mark since the trail was armed. 0 disables.
     */
    trailingStopPct: number;
    stopLossPct: number;
    /** Full exit after this many minutes. 0 disables. */
    maxHoldMinutes: number;
    /** Buy slippage cap (bps). */
    maxSlippageBps: number;
    /**
     * Escalating sell slippage attempts in bps. The first value that lands wins.
     * Default 300, 1000, 2500.
     */
    sellSlippageBps: number[];
    /**
     * Max loss between USD spent and the quote's USD out (price impact + fees), in bps.
     * This is not a comparison to the signal's fill price — alerts do not include one.
     */
    maxChaseBps: number;
    /** New-entry notional cap. Resets at 00:00 UTC with daily_stats.date. */
    dailyBudgetUsd: number;
    /**
     * Pause new entries once today's realized PnL is at or below -this value.
     * Sells still run. 0 disables. Resets at 00:00 UTC.
     */
    dailyLossLimitUsd: number;
    maxOpenPositions: number;
    /** Per-trader minimum seconds between our entries. */
    cooldownSeconds: number;
    copySells: boolean;
    /** Simulate Jupiter TX via RPC before signing (live only). Default true. */
    simulateBeforeSign: boolean;
    /**
     * Slack added on top of Jupiter-reported signature+priority fees, or the
     * entire unexplained fee budget when the order omits fee fields and
     * simMaxFeeLamports is not the one applied. Default 50000.
     */
    simMaxExtraLamports: number;
    /** Fee budget (lamports) used when Jupiter does not report signature/priority fees. */
    simMaxFeeLamports: number;
    /**
     * Hard ceiling on SOL spent beyond the swap input (ATA rent + signature + priority).
     * Default 3000000 (~0.003 SOL). Real overspend above this is rejected.
     */
    simMaxOverheadLamports: number;
    /** Extra raw token units tolerated on input ATA outflow. Default 0. */
    simMaxExtraTokenOutflow: number;
    /** After a full Solana exit, close the empty token account and reclaim rent. */
    closeEmptyTokenAccount: boolean;
    /** Consecutive failed TP/SL quotes before a position is written off. */
    quoteFailWriteoffCount: number;
    /** Failed mirrored-sell attempts (including the first) before giving up on that event. */
    mirroredSellMaxRetries: number;
    /** Jupiter inUsdValue may exceed maxUsdPerTrade by this many bps. */
    inUsdToleranceBps: number;
    /** Two SOL/USD sources may differ by at most this many bps. */
    solPriceDivergenceBps: number;
    /** Top-level programs allowed in a signed Jupiter transaction. */
    solanaProgramAllowlist: string[];
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
    /** When true, REST /v2/alerts runs only while no FOMO alert socket is open. */
    alertsRestOnlyWhenWsDown: boolean;
    /** REST poll interval. Used as the WS-down fallback cadence (and always, if onlyWhenWsDown is false). */
    alertsRestIntervalSec: number;
    tpSlCheckIntervalSec: number;
    /**
     * How often to compare open positions to the trader's FOMO positions.
     * Each cycle costs one normal read (250 credits) per trader who still has an open position.
     * 0 disables. Default 10800 (3h) so a top-3 book stays inside a free-tier month.
     */
    positionReconcileIntervalSec: number;
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
  /** open | closing | closed | dry_open | dry_closed | written_off | dry_written_off */
  status:
    | "open"
    | "closing"
    | "closed"
    | "dry_open"
    | "dry_closed"
    | "written_off"
    | "dry_written_off";
  isDryRun: boolean;
  closedAt?: string;
  exitUsd?: number;
  exitReason?: string;
  realizedPnlUsd?: number;
  txEntry?: string | null;
  txExit?: string | null;
  /** Actual USD value of the entry fill (quote in-USD, else the sized notional). */
  usdIn?: number | null;
  /** Cumulative USD received on sells. */
  usdOut?: number | null;
  solInLamports?: string | null;
  solOutLamports?: string | null;
  feeLamports?: string | null;
  rentPaidLamports?: string | null;
  rentReclaimedLamports?: string | null;
  /** Highest mark seen since the trailing stop was armed. Null until seeded. */
  peakMarkUsd?: number | null;
  /** Set after the first partial mirrored sell. Arms the trailing stop on the remainder. */
  trailArmed?: boolean;
  quoteFailures?: number;
}

export interface DailyStats {
  date: string;
  spentUsd: number;
  realizedPnlUsd: number;
  /** Paper PnL from DRY_RUN closes. Does not affect the live loss limit. */
  paperRealizedPnlUsd: number;
  /** Paper notional spent while DRY_RUN. Kept off spent_usd. */
  paperSpentUsd: number;
  trades: number;
}

export interface TraderStats {
  traderUserId: string | null;
  traderHandle: string | null;
  closes: number;
  wins: number;
  realizedPnlUsd: number;
}

export interface SkipRecord {
  id: number;
  ts: string;
  eventId: string | null;
  reason: string;
  detail: string | null;
  trader: string | null;
  tokenAddress: string | null;
  side: string | null;
  isDryRun: boolean;
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
  | "same_batch_sell"
  | "token_cap"
  | "daily_loss_limit"
  | "round_trip"
  | "overhead"
  | "other";
