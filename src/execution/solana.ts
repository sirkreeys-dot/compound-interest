/**
 * Solana swaps via Jupiter Swap API v2: GET /order (+ optional POST /execute).
 * LIVE path: validate order → simulate balances → pending ledger → sign → execute.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";
import type { EnvConfig } from "../config.js";
import { validateJupiterOrder } from "../security/jupiterTx.js";
import { redactSecrets } from "../security/redact.js";
import { simulateAndValidateSwap } from "../security/simulateSwap.js";
import { roundTripRejection } from "../security/roundTrip.js";
import {
  evaluateLiquidity,
  evaluateTopHolder,
  fetchDexScreenerLiquidity,
  fetchLargestHolderAmount,
  inspectSolanaMint,
  isPublicSolanaRpc,
  type TokenSafetyMode,
} from "../security/tokenSafety.js";
import { closeEmptyTokenAccount } from "./closeAta.js";
import type { Store } from "../store/db.js";
import type { AppConfig } from "../types.js";
import { log } from "../utils/logger.js";
import { usdToTokenRaw } from "../utils/money.js";
import type { PriceService } from "../utils/prices.js";
import type { Executor, SwapRequest, SwapResult } from "./types.js";

const JUP_BASE = "https://api.jup.ag/swap/v2";

/** Start both promises before awaiting either. Safety never signs; /order never signs. */
export function parallelSafetyAndOrder<A, B>(
  safety: () => Promise<A>,
  order: () => Promise<B>,
): Promise<[A, B]> {
  return Promise.all([safety(), order()]);
}

interface JupiterOrder {
  transaction?: string | null;
  requestId?: string;
  outAmount?: string;
  inAmount?: string;
  inputMint?: string;
  outputMint?: string;
  outUsdValue?: number;
  inUsdValue?: number;
  slippageBps?: number;
  taker?: string | null;
  otherAmountThreshold?: string;
  errorCode?: number;
  errorMessage?: string;
  router?: string;
  signatureFeeLamports?: number;
  prioritizationFeeLamports?: number;
  rentFeeLamports?: number;
}

export class SolanaExecutor implements Executor {
  readonly chain = "solana" as const;
  private readonly keypair: Keypair | null;
  private readonly apiKey: string;
  private readonly cfg: AppConfig;
  private readonly prices: PriceService;
  private readonly rpcUrl: string;
  private readonly store: Store | null;

  constructor(env: EnvConfig, cfg: AppConfig, prices: PriceService, store: Store | null = null) {
    this.cfg = cfg;
    this.apiKey = env.jupiterApiKey;
    this.prices = prices;
    this.rpcUrl = env.solanaRpcUrl;
    this.store = store;
    if (env.solanaPrivateKey) {
      try {
        this.keypair = Keypair.fromSecretKey(bs58.decode(env.solanaPrivateKey));
      } catch {
        try {
          const arr = JSON.parse(env.solanaPrivateKey) as number[];
          this.keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
        } catch {
          log.error("Invalid SOLANA_PRIVATE_KEY (need base58 or JSON byte array)");
          this.keypair = null;
        }
      }
    } else {
      this.keypair = null;
    }
  }

  ready(): boolean {
    return this.keypair !== null;
  }

  publicKey(): string | null {
    return this.keypair?.publicKey.toBase58() ?? null;
  }

  async buyToken(req: SwapRequest): Promise<SwapResult> {
    const sellToken = this.cfg.quote.preferStableBuys
      ? this.cfg.quote.solanaStable
      : this.cfg.quote.solanaNative;
    return this.swap({ ...req, sellToken, buyToken: req.buyToken }, "buy");
  }

  /** Close the empty ATA for `mint` and reclaim rent. Live Solana only. */
  async reclaimRent(mint: string): Promise<{ ok: boolean; rentLamports?: number; error?: string }> {
    if (!this.keypair) return { ok: false, error: "no keypair" };
    const result = await closeEmptyTokenAccount({
      rpcUrl: this.rpcUrl,
      owner: this.keypair,
      mint,
    });
    return {
      ok: result.ok,
      rentLamports: result.rentLamports,
      error: result.closed ? undefined : result.error,
    };
  }

  async sellToken(req: SwapRequest): Promise<SwapResult> {
    return this.swap(
      {
        ...req,
        sellToken: req.sellToken,
        buyToken: this.cfg.quote.solanaNative,
      },
      "sell",
    );
  }

  private async requestOrder(opts: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    taker: string | null;
  }): Promise<{ ok: true; order: JupiterOrder } | { ok: false; error: string }> {
    const params = new URLSearchParams({
      inputMint: opts.inputMint,
      outputMint: opts.outputMint,
      amount: opts.amount,
      slippageBps: String(opts.slippageBps),
    });
    if (opts.taker) params.set("taker", opts.taker);
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const orderRes = await fetch(`${JUP_BASE}/order?${params}`, { headers });
    if (!orderRes.ok) {
      const t = await orderRes.text();
      return {
        ok: false,
        error: redactSecrets(`Jupiter /order ${orderRes.status}: ${t.slice(0, 200)}`),
      };
    }
    const order = (await orderRes.json()) as JupiterOrder;
    return { ok: true, order };
  }

  private reportedFees(order: JupiterOrder): number | null {
    if (order.signatureFeeLamports == null && order.prioritizationFeeLamports == null) return null;
    return (order.signatureFeeLamports ?? 0) + (order.prioritizationFeeLamports ?? 0);
  }

  /** Quoted rent + fees above the hard ceiling are rejected in dry-run and live. */
  private quotedOverheadError(order: JupiterOrder): string | null {
    const ceiling = this.cfg.risk.simMaxOverheadLamports ?? 0;
    if (!(ceiling > 0)) return null;
    const has =
      order.rentFeeLamports != null ||
      order.signatureFeeLamports != null ||
      order.prioritizationFeeLamports != null;
    if (!has) return null;
    const total =
      (order.rentFeeLamports ?? 0) +
      (order.signatureFeeLamports ?? 0) +
      (order.prioritizationFeeLamports ?? 0);
    if (total > ceiling) {
      return `overhead: quoted rent+fees ${total} lamports > simMaxOverheadLamports ${ceiling}`;
    }
    return null;
  }

  /**
   * maxChaseBps is the max gap between USD spent and quote USD out
   * (impact + fees). Alerts do not carry a token price, so this is not
   * "price moved vs the signal".
   */
  private chaseError(sellUsd: number, outUsd: number | undefined): string | null {
    if (!(this.cfg.risk.maxChaseBps > 0) || !(sellUsd > 0) || outUsd == null || !(outUsd > 0)) {
      return null;
    }
    const lossBps = Math.round((1 - outUsd / sellUsd) * 10_000);
    if (lossBps > this.cfg.risk.maxChaseBps) {
      return `chase_limit: quote loss ${lossBps}bps > maxChaseBps ${this.cfg.risk.maxChaseBps}`;
    }
    return null;
  }

  private async roundTripError(
    buyToken: string,
    outAmount: string | undefined,
    sellUsd: number,
  ): Promise<string | null> {
    const max = this.cfg.filters.roundTripMaxLossBps ?? 0;
    if (!(max > 0)) return null;
    if (!outAmount || outAmount === "0") {
      return "round_trip: missing buy outAmount (fail closed)";
    }
    const quoted = await this.requestOrder({
      inputMint: buyToken,
      outputMint: this.cfg.quote.solanaNative,
      amount: outAmount,
      slippageBps: this.cfg.risk.maxSlippageBps,
      taker: null,
    });
    if (!quoted.ok) return `round_trip: sell quote failed (fail closed): ${quoted.error}`;
    let outUsd =
      quoted.order.outUsdValue != null && quoted.order.outUsdValue > 0
        ? quoted.order.outUsdValue
        : null;
    if (outUsd == null && quoted.order.outAmount) {
      const valued = await this.prices.rawOutToUsd({
        chain: "solana",
        buyToken: this.cfg.quote.solanaNative,
        outAmountRaw: quoted.order.outAmount,
        quoteOutUsdValue: quoted.order.outUsdValue,
      });
      outUsd = valued?.usd ?? null;
    }
    return roundTripRejection(sellUsd, outUsd, max);
  }

  private feeFields(
    order: JupiterOrder,
    req: SwapRequest,
    side: "buy" | "sell",
  ): Pick<SwapResult, "inUsd" | "feeLamports" | "rentLamports" | "solInLamports" | "solOutLamports"> {
    const fees = this.reportedFees(order);
    const native = this.cfg.quote.solanaNative;
    const solIn =
      side === "buy" && req.sellToken === native ? (order.inAmount ?? undefined) : undefined;
    const solOut =
      side === "sell" && req.buyToken === native ? (order.outAmount ?? undefined) : undefined;
    return {
      inUsd: order.inUsdValue != null && order.inUsdValue > 0 ? order.inUsdValue : undefined,
      feeLamports: fees ?? undefined,
      rentLamports:
        order.rentFeeLamports != null && order.rentFeeLamports > 0
          ? order.rentFeeLamports
          : undefined,
      solInLamports: solIn,
      solOutLamports: solOut,
    };
  }

  private async checkTokenSafety(mint: string) {
    const mode = (this.cfg.filters.tokenSafety ?? "block") as TokenSafetyMode;
    if (mode === "off") return null;
    if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) return null;
    const finding = await inspectSolanaMint(this.rpcUrl, mint, {
      mode,
      blockFreezeAuthority: this.cfg.filters.blockFreezeAuthority ?? true,
      blockTransferHooks: this.cfg.filters.blockTransferHooks ?? true,
      blockMintAuthority: this.cfg.filters.blockMintAuthority ?? true,
    });
    if (finding.blocked) return finding;

    const maxBps = this.cfg.filters.maxTopHolderBps ?? 0;
    if (maxBps > 0) {
      const largest = await fetchLargestHolderAmount(this.rpcUrl, mint);
      let supply: bigint | null = null;
      if (finding.supply && /^\d+$/.test(finding.supply)) supply = BigInt(finding.supply);
      const judged = evaluateTopHolder({
        maxTopHolderBps: maxBps,
        topAmount: largest.amount,
        supply,
        fetchFailed: largest.failed,
      });
      if (judged.blocked) {
        const hint = isPublicSolanaRpc(this.rpcUrl)
          ? " Public mainnet RPC returns 429 for getTokenLargestAccounts; a paid RPC is required and this check is not disabled."
          : "";
        finding.warnings.push(judged.detail + hint);
        if (mode === "block") {
          finding.blocked = true;
          finding.blockReason = "top_holder";
          return finding;
        }
      }
    }

    const minLiq = this.cfg.filters.minLiquidityUsd ?? 0;
    if (minLiq > 0) {
      const liq = await fetchDexScreenerLiquidity(mint);
      const judged = evaluateLiquidity({
        minLiquidityUsd: minLiq,
        liquidityUsd: liq.liquidityUsd,
        fetchFailed: liq.fetchFailed,
      });
      if (judged.blocked) {
        finding.warnings.push(judged.detail);
        if (mode === "block") {
          finding.blocked = true;
          finding.blockReason = "low_liquidity";
        }
      }
    }
    return finding;
  }

  private async swap(req: SwapRequest, side: "buy" | "sell"): Promise<SwapResult> {
    let pendingId = req.pendingId;
    try {
      if (!req.dryRun && !this.keypair) {
        return { ok: false, dryRun: false, error: "LIVE mode requires SOLANA_PRIVATE_KEY", pendingId };
      }
      const headers: Record<string, string> = {};
      if (this.apiKey) headers["x-api-key"] = this.apiKey;

      let amount = req.sellAmountRaw;
      if (!amount) {
        amount = (await this.usdToRaw(req.sellToken, req.sellUsd)) ?? undefined;
      }
      if (!amount || amount === "0") {
        return {
          ok: false,
          dryRun: req.dryRun,
          error:
            "Could not size sell amount — need fresh SOL/USDC price or sellAmountRaw (refused)",
          pendingId,
        };
      }

      const taker = this.keypair && !req.dryRun ? this.keypair.publicKey.toBase58() : null;
      const [safety, ordered] = await parallelSafetyAndOrder(
        () => (side === "buy" ? this.checkTokenSafety(req.buyToken) : Promise.resolve(null)),
        () =>
          this.requestOrder({
            inputMint: req.sellToken,
            outputMint: req.buyToken,
            amount,
            slippageBps: req.slippageBps,
            taker,
          }),
      );
      if (safety?.blocked) {
        return {
          ok: false,
          dryRun: req.dryRun,
          error: `token_safety: ${safety.blockReason ?? "blocked"} (${safety.warnings.join("; ")})`,
          pendingId,
        };
      }
      if (safety && safety.warnings.length) {
        log.warn(`tokenSafety ${req.buyToken}: ${safety.warnings.join("; ")}`);
      }
      if (!ordered.ok) {
        return { ok: false, dryRun: req.dryRun, error: ordered.error, pendingId };
      }
      const order = ordered.order;

      const summary = `jupiter router=${order.router ?? "?"} in=${order.inAmount ?? amount} out=${order.outAmount ?? "?"}`;
      const outUsd =
        (order.outUsdValue != null && order.outUsdValue > 0
          ? order.outUsdValue
          : null) ??
        (
          await this.prices.rawOutToUsd({
            chain: "solana",
            buyToken: req.buyToken,
            outAmountRaw: order.outAmount ?? "",
            quoteOutUsdValue: order.outUsdValue,
          })
        )?.usd ??
        undefined;

      const overheadError = this.quotedOverheadError(order);
      if (overheadError) {
        return {
          ok: false,
          dryRun: req.dryRun,
          error: overheadError,
          quoteSummary: summary,
          outUsd,
          outAmountRaw: order.outAmount,
          inAmountRaw: order.inAmount ?? amount,
          pendingId,
          ...this.feeFields(order, req, side),
        };
      }

      if (side === "buy") {
        const roundTripError = await this.roundTripError(req.buyToken, order.outAmount, req.sellUsd);
        if (roundTripError) {
          return {
            ok: false,
            dryRun: req.dryRun,
            error: roundTripError,
            quoteSummary: summary,
            outUsd,
            outAmountRaw: order.outAmount,
            inAmountRaw: order.inAmount ?? amount,
            pendingId,
            ...this.feeFields(order, req, side),
          };
        }
      }

      const chaseError = this.chaseError(req.sellUsd, outUsd);
      if (req.dryRun) {
        if (chaseError) {
          return {
            ok: false,
            dryRun: true,
            error: chaseError,
            quoteSummary: summary,
            outUsd,
            outAmountRaw: order.outAmount,
            inAmountRaw: order.inAmount ?? amount,
            pendingId,
            ...this.feeFields(order, req, side),
          };
        }
        return {
          ok: true,
          dryRun: true,
          outAmountRaw: order.outAmount,
          inAmountRaw: order.inAmount ?? amount,
          outUsd,
          quoteSummary: summary,
          pendingId,
          ...this.feeFields(order, req, side),
        };
      }

      const validated = validateJupiterOrder({
        order,
        expectedInputMint: req.sellToken,
        expectedOutputMint: req.buyToken,
        expectedInAmount: amount,
        maxSlippageBps: req.slippageBps,
        ourPubkey: this.keypair!.publicKey,
        sellUsd: req.sellUsd,
        outUsd,
        maxChaseBps: this.cfg.risk.maxChaseBps,
      });
      if (!validated.ok) {
        this.failPending(pendingId, validated.error);
        return {
          ok: false,
          dryRun: false,
          error: redactSecrets(validated.error),
          quoteSummary: summary,
          pendingId,
        };
      }

      const tx: VersionedTransaction = validated.tx;

      // Pre-sign simulation (fail closed). Skip only when explicitly disabled.
      if (this.cfg.risk.simulateBeforeSign !== false) {
        // Skip real RPC on loopback — tests inject via unit module; live loopback fails closed.
        if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) {
          this.failPending(pendingId, "sim: refused — loopback RPC cannot simulate");
          return {
            ok: false,
            dryRun: false,
            error: "sim: refused — loopback RPC cannot simulate (fail closed)",
            quoteSummary: summary,
            pendingId,
          };
        }
        const sim = await simulateAndValidateSwap({
          rpcUrl: this.rpcUrl,
          tx,
          ourPubkey: this.keypair!.publicKey,
          inputMint: req.sellToken,
          outputMint: req.buyToken,
          expectedInAmount: order.inAmount ?? amount,
          otherAmountThreshold: order.otherAmountThreshold ?? null,
          maxExtraLamports: this.cfg.risk.simMaxExtraLamports ?? 50_000,
          maxFeeLamports: this.cfg.risk.simMaxFeeLamports ?? 1_000_000,
          maxOverheadLamports: this.cfg.risk.simMaxOverheadLamports ?? 3_000_000,
          reportedFeeLamports: this.reportedFees(order),
          maxExtraTokenOutflow: BigInt(this.cfg.risk.simMaxExtraTokenOutflow ?? 0),
        });
        if (!sim.ok) {
          this.failPending(pendingId, sim.error);
          return {
            ok: false,
            dryRun: false,
            error: redactSecrets(sim.error),
            quoteSummary: summary,
            pendingId,
          };
        }
      }

      // Ensure pending row exists before broadcast (copy engine usually creates it)
      if (side === "buy" && this.store) {
        if (!pendingId) {
          pendingId = randomUUID();
          this.store.insertPendingSwap({
            id: pendingId,
            chain: "solana",
            side: "buy",
            sourceEventId: req.sourceEventId ?? null,
            traderUserId: req.traderUserId ?? null,
            traderHandle: req.traderHandle ?? null,
            tokenAddress: req.buyToken,
            tokenSymbol: req.tokenSymbol ?? null,
            sizeUsd: req.sellUsd,
            sellToken: req.sellToken,
            buyToken: req.buyToken,
            inAmountRaw: order.inAmount ?? amount,
            expectedOutRaw: order.outAmount ?? null,
            notes: "created_by_executor",
          });
        } else {
          this.store.updatePendingSwap(pendingId, {
            inAmountRaw: order.inAmount ?? amount,
            expectedOutRaw: order.outAmount ?? null,
          });
        }
      }

      tx.sign([this.keypair!]);
      const signed = Buffer.from(tx.serialize()).toString("base64");

      const execRes = await fetch(`${JUP_BASE}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ signedTransaction: signed, requestId: order.requestId }),
      });
      if (!execRes.ok) {
        const t = await execRes.text();
        this.failPending(pendingId, `Jupiter /execute ${execRes.status}`);
        return {
          ok: false,
          dryRun: false,
          error: redactSecrets(`Jupiter /execute ${execRes.status}: ${t.slice(0, 200)}`),
          pendingId,
        };
      }
      const result = (await execRes.json()) as {
        status?: string;
        signature?: string;
        totalOutputAmount?: string;
        totalInputAmount?: string;
        error?: string;
      };

      if (pendingId && this.store) {
        this.store.updatePendingSwap(pendingId, {
          status: "broadcast",
          txSignature: result.signature ?? null,
        });
      }

      if (result.status !== "Success") {
        this.failPending(pendingId, result.error ?? `status=${result.status}`);
        return {
          ok: false,
          dryRun: false,
          txHash: result.signature,
          error: redactSecrets(result.error ?? `status=${result.status}`),
          quoteSummary: summary,
          pendingId,
        };
      }

      if (pendingId && this.store) {
        this.store.updatePendingSwap(pendingId, {
          status: "confirmed",
          txSignature: result.signature ?? null,
        });
      }

      const liveOut =
        (
          await this.prices.rawOutToUsd({
            chain: "solana",
            buyToken: req.buyToken,
            outAmountRaw: result.totalOutputAmount ?? order.outAmount ?? "",
            quoteOutUsdValue: order.outUsdValue,
          })
        )?.usd ?? outUsd;
      return {
        ok: true,
        dryRun: false,
        txHash: result.signature,
        outAmountRaw: result.totalOutputAmount,
        inAmountRaw: result.totalInputAmount,
        outUsd: liveOut,
        quoteSummary: summary,
        pendingId,
        ...this.feeFields(order, req, side),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.failPending(pendingId, msg);
      return {
        ok: false,
        dryRun: req.dryRun,
        error: redactSecrets(msg),
        pendingId,
      };
    }
  }

  private failPending(pendingId: string | undefined, error: string): void {
    if (!pendingId || !this.store) return;
    this.store.updatePendingSwap(pendingId, {
      status: "failed",
      error: redactSecrets(error).slice(0, 500),
    });
  }

  private async usdToRaw(mint: string, usd: number): Promise<string | null> {
    if (mint === this.cfg.quote.solanaStable) {
      return usdToTokenRaw(usd, 6, 1);
    }
    if (mint === this.cfg.quote.solanaNative) {
      const price = await this.prices.getSolUsd();
      log.debug(`SOL USD price $${price.usd} via ${price.source}`);
      return usdToTokenRaw(usd, 9, price.usd);
    }
    return null;
  }
}
