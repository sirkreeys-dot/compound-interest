import type { EnvConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { AppConfig, ChainName } from "../types.js";
import { PriceService } from "../utils/prices.js";
import { BaseExecutor } from "./base.js";
import { SolanaExecutor } from "./solana.js";
import type { Executor, SwapRequest, SwapResult } from "./types.js";

export class ExecutionRouter {
  readonly solana: SolanaExecutor | null;
  /** Null when cfg.chains.base is false — no Base RPC / ZEROX usage at construct time. */
  readonly base: BaseExecutor | null;
  readonly prices: PriceService;
  private readonly cfg: AppConfig;

  constructor(env: EnvConfig, cfg: AppConfig, prices?: PriceService, store: Store | null = null) {
    this.cfg = cfg;
    this.prices =
      prices ??
      new PriceService({
        jupiterApiKey: env.jupiterApiKey,
        zeroXApiKey: cfg.chains.base ? env.zeroXApiKey : "",
      });
    this.solana = cfg.chains.solana ? new SolanaExecutor(env, cfg, this.prices, store) : null;
    this.base = cfg.chains.base ? new BaseExecutor(env, cfg, this.prices) : null;
  }

  forChain(chain: ChainName): Executor | null {
    if (chain === "solana") return this.solana;
    if (chain === "base") return this.base;
    return null;
  }

  async buy(chain: ChainName, req: Omit<SwapRequest, "chain">): Promise<SwapResult> {
    const ex = this.forChain(chain);
    if (!ex) {
      return {
        ok: false,
        dryRun: req.dryRun,
        error: `${chain} disabled or no executor (chains.${chain}=false)`,
      };
    }
    return ex.buyToken({ ...req, chain });
  }

  async sell(chain: ChainName, req: Omit<SwapRequest, "chain">): Promise<SwapResult> {
    const ex = this.forChain(chain);
    if (!ex) {
      return {
        ok: false,
        dryRun: req.dryRun,
        error: `${chain} disabled or no executor (chains.${chain}=false)`,
      };
    }
    return ex.sellToken({ ...req, chain });
  }
}

export type { SwapRequest, SwapResult, Executor };
