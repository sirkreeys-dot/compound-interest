import type { ChainName } from "../types.js";

export interface SwapRequest {
  chain: ChainName;
  /** Token we spend (SOL mint / WETH / USDC etc.) */
  sellToken: string;
  /** Token we receive */
  buyToken: string;
  /** Human USD notional we intend to spend (for logging / sizing). */
  sellUsd: number;
  /** Amount in smallest units of sellToken, if known; else executor sizes from USD. */
  sellAmountRaw?: string;
  slippageBps: number;
  dryRun: boolean;
  /** Live buys: pending_swaps row id written before broadcast. */
  pendingId?: string;
  /** Live buys: FOMO event id for ledger. */
  sourceEventId?: string;
  traderUserId?: string | null;
  traderHandle?: string | null;
  tokenSymbol?: string | null;
}

export interface SwapResult {
  ok: boolean;
  dryRun: boolean;
  txHash?: string;
  /** Estimated or actual output amount (raw). */
  outAmountRaw?: string;
  /** USD estimate of output if available. */
  outUsd?: number;
  /** Sell amount actually used (raw). */
  inAmountRaw?: string;
  priceImpactBps?: number;
  error?: string;
  quoteSummary?: string;
  /** Echo pending ledger id when used. */
  pendingId?: string;
}

export interface Executor {
  readonly chain: ChainName;
  ready(): boolean;
  /** Approximate native/stable USD price helpers left to executor. */
  buyToken(req: SwapRequest): Promise<SwapResult>;
  sellToken(req: SwapRequest): Promise<SwapResult>;
}
