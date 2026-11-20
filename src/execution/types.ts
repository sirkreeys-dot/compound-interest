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
  /** Called immediately before tx.sign. Throw to refuse the signature. */
  beforeSign?: () => void | Promise<void>;
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
  /** Quote or fill USD value of the sold side, when the venue reports it. */
  inUsd?: number;
  /** Signature + priority fees in lamports, when reported. */
  feeLamports?: number;
  /** ATA rent charged on the fill, in lamports, when reported. */
  rentLamports?: number;
  /** Lamports of SOL actually spent (native-SOL input only). */
  solInLamports?: string;
  /** Lamports of SOL actually received (native-SOL output only). */
  solOutLamports?: string;
  /** Previous signature is not confirmed failed. Do not sign another transaction. */
  inFlight?: boolean;
}

export interface Executor {
  readonly chain: ChainName;
  ready(): boolean;
  /** Approximate native/stable USD price helpers left to executor. */
  buyToken(req: SwapRequest): Promise<SwapResult>;
  sellToken(req: SwapRequest): Promise<SwapResult>;
}
