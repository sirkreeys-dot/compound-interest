/**
 * Solana swaps via Jupiter Swap API v2: GET /order (+ optional POST /execute).
 * LIVE path: validate order → simulate balances → pending ledger → sign → execute.
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";
import type { EnvConfig } from "../config.js";
import { validateJupiterOrder } from "../security/jupiterTx.js";
import {
  accountKeysFromLoadedMessage,
  inspectSwapInstructions,
} from "../security/programAllowlist.js";
import { EXECUTE_TIMEOUT_MS, QUOTE_TIMEOUT_MS, fetchRetry, fetchTimeout, rpcConnection } from "../utils/http.js";
import { classifySellSimulation, combineBuyAndSellForSim } from "../security/sellSim.js";
import { evaluateFakeLiquidity, evaluateQuoteDepth, jupiterImpactBps, bestSolanaPair } from "../security/fakeLiquidity.js";
import { redactSecrets } from "../security/redact.js";
import { simulateAndValidateSwap } from "../security/simulateSwap.js";
import { roundTripRejection } from "../security/roundTrip.js";
import {
  evaluateLiquidity,
  evaluateTopHolder,
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
/** Reject a buy unless Jupiter reported an input USD value inside the cap plus a small tolerance. */
export function jupiterInUsdAllowed(
  inUsd: number | null | undefined,
  maxUsdPerTrade: number,
  toleranceBps: number,
): boolean {
  if (inUsd == null || !(inUsd > 0) || !Number.isFinite(inUsd)) return false;
  const cap = maxUsdPerTrade * (1 + Math.max(0, toleranceBps) / 10_000);
  return inUsd <= cap;
}

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
  /** Public taker for DRY_RUN sell simulation. Never a signing key. */
  private readonly dryRunPubkey: string;

  constructor(env: EnvConfig, cfg: AppConfig, prices: PriceService, store: Store | null = null) {
    this.cfg = cfg;
    this.apiKey = env.jupiterApiKey;
    this.prices = prices;
    this.rpcUrl = env.solanaRpcUrl;
    this.store = store;
    this.dryRunPubkey = env.dryRunSolanaPubkey ?? "";
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
    const orderRes = await fetchRetry(`${JUP_BASE}/order?${params}`, { headers }, {
      timeoutMs: QUOTE_TIMEOUT_MS,
      retries: 2,
    });
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

  /** Signing key in live mode, otherwise the configured DRY_RUN public address. */
  private simulationTaker(): string | null {
    if (this.keypair) return this.keypair.publicKey.toBase58();
    return this.dryRunPubkey || null;
  }

  private async roundTripError(
    buyToken: string,
    outAmount: string | undefined,
    sellUsd: number,
    live: boolean,
    buyTxB64: string | null,
  ): Promise<string | null> {
    const max = this.cfg.filters.roundTripMaxLossBps ?? 0;
    if (!(max > 0)) return null;
    if (!outAmount || outAmount === "0") {
      return "round_trip: missing buy outAmount (fail closed)";
    }
    const taker = this.simulationTaker();
    const quoted = await this.requestOrder({
      inputMint: buyToken,
      outputMint: this.cfg.quote.solanaNative,
      amount: outAmount,
      slippageBps: this.cfg.risk.maxSlippageBps,
      taker,
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
    const quoteErr = roundTripRejection(sellUsd, outUsd, max);
    if (quoteErr) return quoteErr;
    const depth = await this.quoteDepthError(
      buyToken,
      jupiterImpactBps((quoted.order as { priceImpactPct?: number | string }).priceImpactPct),
    );
    if (depth) return depth;
    if (!taker) {
      log.warn(
        "dryRunSellSim=no_public_key: set DRY_RUN_SOLANA_PUBKEY (a public address, not a secret) to simulate the sell without a private key. The quote is not treated as proof the token can be sold.",
      );
      if (live) return "round_trip: no wallet public key to simulate the sell (fail closed)";
      return null;
    }
    if (!quoted.order.transaction) {
      log.warn(
        "dryRunSellSim=no_sell_tx: Jupiter did not return a sell transaction for this public taker.",
      );
      if (live) return "round_trip: sell order had no transaction to simulate (fail closed)";
      return null;
    }
    return this.simulateRoundTripTx(quoted.order.transaction, buyTxB64, taker, live);
  }

  private async quoteDepthError(mint: string, sellImpactBps: number | null): Promise<string | null> {
    const minLiq = this.cfg.filters.minLiquidityUsd ?? 0;
    const maxImpact = this.cfg.filters.fakeLiquidityImpactBps ?? 0;
    if (!(minLiq > 0) || !(maxImpact > 0)) return null;
    let liquidityUsd: number | null = null;
    try {
      const res = await fetchRetry(
        `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
        {},
        { timeoutMs: QUOTE_TIMEOUT_MS, retries: 2 },
      );
      if (res.ok) {
        const body = (await res.json()) as unknown;
        liquidityUsd = bestSolanaPair(body)?.liquidityUsd ?? null;
      }
    } catch {
      liquidityUsd = null;
    }
    const judged = evaluateQuoteDepth({
      minLiquidityUsd: minLiq,
      liquidityUsd,
      maxImpactBps: maxImpact,
      sellImpactBps,
    });
    return judged.blocked ? judged.detail : null;
  }

  /**
   * Simulate buy-then-sell as one transaction. Never signs or broadcasts.
   * sigVerify is false, so a private key is not required. The buy runs first
   * inside the simulation so the sell can see tokens a fresh wallet does not hold.
   * If the bundle cannot be built, dry-run logs dryRunSellSim=bundle_unavailable
   * and does not treat the quote as proof of a sell. Live mode fails closed.
   */
  private async simulateRoundTripTx(
    sellB64: string,
    buyB64: string | null,
    taker: string,
    live: boolean,
  ): Promise<string | null> {
    let sellTx: VersionedTransaction;
    try {
      sellTx = VersionedTransaction.deserialize(Buffer.from(sellB64, "base64"));
    } catch {
      return "round_trip: sell transaction did not deserialize (fail closed)";
    }
    const payer = new PublicKey(taker);
    let simTx = sellTx;
    let bundled = false;
    if (buyB64) {
      try {
        const buyTx = VersionedTransaction.deserialize(Buffer.from(buyB64, "base64"));
        const tables = await this.loadLookupTables(buyTx, sellTx);
        if (tables) {
          const buyKeys = accountKeysFromLoadedMessage(buyTx, tables.buy);
          const sellKeys = accountKeysFromLoadedMessage(sellTx, tables.sell);
          if (buyKeys && sellKeys) {
            simTx = combineBuyAndSellForSim({
              buy: buyTx,
              sell: sellTx,
              buyKeys,
              sellKeys,
              payer,
              lookupTables: [...tables.buy, ...tables.sell],
            });
            bundled = true;
          }
        }
      } catch (e) {
        log.warn("dryRunSellSim=bundle_unavailable", e);
      }
    }
    if (!bundled) {
      log.warn(
        "dryRunSellSim=bundle_unavailable: could not simulate the buy and sell as one transaction (lookup tables or a missing buy tx). A sell of tokens this wallet does not hold yet cannot be distinguished from a honeypot. The quote is not treated as proof of a sell.",
      );
      if (live) return "round_trip: cannot build buy+sell simulation (fail closed)";
      return null;
    }
    const guarded = await this.guardSwapTx(simTx, payer);
    if (!guarded.ok) return `round_trip: ${guarded.error}`;
    if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) {
      if (live) return "round_trip: cannot simulate sell on loopback RPC (fail closed)";
      log.warn("dryRunSellSim=no_rpc: loopback RPC cannot simulate the bundled sell.");
      return null;
    }
    try {
      const conn = rpcConnection(this.rpcUrl);
      const sim = await conn.simulateTransaction(simTx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      const klass = classifySellSimulation(sim.value.err, sim.value.logs);
      if (klass === "ok") return null;
      if (klass === "no_balance") {
        log.warn(
          "dryRunSellSim=no_balance: the bundled simulation could not pay for the buy or credit the token. An empty public key cannot prove the sell. This is not treated as a successful sell.",
        );
        if (live) return "round_trip: sell simulation had no token balance after the buy (fail closed)";
        return null;
      }
      return `round_trip: sell simulation failed (honeypot, fail closed): ${JSON.stringify(sim.value.err)}`;
    } catch (e) {
      return `round_trip: sell simulation threw (fail closed): ${e instanceof Error ? e.message : String(e)}`;
    }
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
      maxTransferFeeBps: this.cfg.filters.maxTransferFeeBps ?? 100,
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
      let body: unknown = null;
      let fetchFailed = false;
      try {
        const res = await fetchRetry(
          `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
          {},
          { timeoutMs: QUOTE_TIMEOUT_MS, retries: 2 },
        );
        if (!res.ok) fetchFailed = true;
        else body = await res.json();
      } catch {
        fetchFailed = true;
      }
      const pair = body ? bestSolanaPair(body) : null;
      const judged = evaluateLiquidity({
        minLiquidityUsd: minLiq,
        liquidityUsd: pair?.liquidityUsd ?? null,
        fetchFailed: fetchFailed || pair == null,
      });
      if (judged.blocked) {
        finding.warnings.push(judged.detail);
        if (mode === "block") {
          finding.blocked = true;
          finding.blockReason = "low_liquidity";
        }
      } else {
        const fake = evaluateFakeLiquidity({
          minLiquidityUsd: minLiq,
          minPairAgeSec: this.cfg.filters.minPairAgeSec ?? 0,
          nowMs: Date.now(),
          pair,
          fetchFailed,
        });
        if (fake.blocked) {
          finding.warnings.push(fake.detail);
          if (mode === "block") {
            finding.blocked = true;
            finding.blockReason = "fake_liquidity";
          }
        }
      }
    }
    return finding;
  }

  private async swap(req: SwapRequest, side: "buy" | "sell"): Promise<SwapResult> {
    let pendingId = req.pendingId;
    let broadcastSig: string | null = null;
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

      const taker = !req.dryRun
        ? this.keypair?.publicKey.toBase58() ?? null
        : this.simulationTaker();
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
        const roundTripError = await this.roundTripError(
          req.buyToken,
          order.outAmount,
          req.sellUsd,
          !req.dryRun,
          order.transaction ?? null,
        );
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

      if (side === "buy") {
        const tolBps = this.cfg.risk.inUsdToleranceBps ?? 200;
        if (!jupiterInUsdAllowed(order.inUsdValue, this.cfg.sizing.maxUsdPerTrade, tolBps)) {
          return {
            ok: false,
            dryRun: req.dryRun,
            error: `in_usd: Jupiter inUsdValue ${order.inUsdValue ?? "missing"} exceeds maxUsdPerTrade ${this.cfg.sizing.maxUsdPerTrade} plus ${tolBps}bps`,
            quoteSummary: summary,
            outUsd,
            pendingId,
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
      const guarded = await this.guardSwapTx(tx);
      if (!guarded.ok) {
        this.failPending(pendingId, guarded.error);
        return {
          ok: false,
          dryRun: false,
          error: redactSecrets(guarded.error),
          quoteSummary: summary,
          pendingId,
        };
      }

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
          extraAccountKeys: guarded.accountKeys,
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

      // Ensure pending row exists before broadcast (buys and sells).
      if (this.store && (side === "buy" || side === "sell")) {
        if (!pendingId) {
          pendingId = randomUUID();
          this.store.insertPendingSwap({
            id: pendingId,
            chain: "solana",
            side,
            sourceEventId: req.sourceEventId ?? null,
            traderUserId: req.traderUserId ?? null,
            traderHandle: req.traderHandle ?? null,
            tokenAddress: side === "sell" ? req.sellToken : req.buyToken,
            tokenSymbol: req.tokenSymbol ?? null,
            sizeUsd: req.sellUsd,
            sellToken: req.sellToken,
            buyToken: req.buyToken,
            inAmountRaw: order.inAmount ?? amount,
            expectedOutRaw: order.outAmount ?? null,
            notes: "created_by_executor",
            positionId: req.positionId ?? null,
          });
        } else {
          this.store.updatePendingSwap(pendingId, {
            inAmountRaw: order.inAmount ?? amount,
            expectedOutRaw: order.outAmount ?? null,
          });
        }
      }

      try {
        if (req.beforeSign) await req.beforeSign();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.failPending(pendingId, msg);
        return { ok: false, dryRun: false, error: redactSecrets(msg), quoteSummary: summary, pendingId };
      }
      tx.sign([this.keypair!]);
      const signed = Buffer.from(tx.serialize()).toString("base64");
      const signature = bs58.encode(tx.signatures[0]!);
      broadcastSig = signature;
      let lastValidBlockHeight: number | null = null;
      if (this.rpcUrl && !/127\.0\.0\.1|localhost/i.test(this.rpcUrl)) {
        try {
          const latest = await rpcConnection(this.rpcUrl).getLatestBlockhash("confirmed");
          lastValidBlockHeight = latest.lastValidBlockHeight;
        } catch (e) {
          log.warn("Could not read lastValidBlockHeight before broadcast", e);
        }
      }
      if (pendingId && this.store) {
        this.store.updatePendingSwap(pendingId, {
          status: "broadcast",
          txSignature: signature,
          blockhash: tx.message.recentBlockhash,
          lastValidBlockHeight,
          positionId: req.positionId ?? null,
          notes: `signed_before_execute requestId=${order.requestId ?? ""}`,
        });
      }

      const execRes = await fetchTimeout(
        `${JUP_BASE}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ signedTransaction: signed, requestId: order.requestId }),
        },
        EXECUTE_TIMEOUT_MS,
      );
      if (!execRes.ok) {
        const t = await execRes.text();
        const landed = await this.signatureOutcome(signature);
        if (landed === "success") {
          if (pendingId && this.store) {
            this.store.updatePendingSwap(pendingId, { status: "confirmed", txSignature: signature });
          }
          return {
            ok: true,
            dryRun: false,
            txHash: signature,
            outAmountRaw: order.outAmount,
            inAmountRaw: order.inAmount ?? amount,
            outUsd,
            quoteSummary: summary,
            pendingId,
            ...this.feeFields(order, req, side),
          };
        }
        if (landed === "pending") {
          return {
            ok: false,
            dryRun: false,
            inFlight: true,
            txHash: signature,
            error: "sell_in_flight: signature not confirmed failed; not signing another transaction",
            quoteSummary: summary,
            pendingId,
          };
        }
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
        const landed = await this.signatureOutcome(result.signature ?? signature);
        if (landed === "success") {
          if (pendingId && this.store) {
            this.store.updatePendingSwap(pendingId, { status: "confirmed", txSignature: result.signature ?? signature });
          }
          return {
            ok: true,
            dryRun: false,
            txHash: result.signature ?? signature,
            outAmountRaw: result.totalOutputAmount ?? order.outAmount,
            inAmountRaw: result.totalInputAmount ?? order.inAmount ?? amount,
            outUsd,
            quoteSummary: summary,
            pendingId,
            ...this.feeFields(order, req, side),
          };
        }
        if (landed === "pending") {
          return {
            ok: false,
            dryRun: false,
            inFlight: true,
            txHash: result.signature ?? signature,
            error: "in_flight: signature not confirmed failed; not signing another transaction",
            quoteSummary: summary,
            pendingId,
          };
        }
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
      if (broadcastSig) {
        return {
          ok: false,
          dryRun: false,
          inFlight: true,
          txHash: broadcastSig,
          error: redactSecrets(`broadcast_unconfirmed: ${msg}`),
          pendingId,
        };
      }
      this.failPending(pendingId, msg);
      return {
        ok: false,
        dryRun: req.dryRun,
        error: redactSecrets(msg),
        pendingId,
      };
    }
  }

  private async loadLookupTables(
    buy: VersionedTransaction,
    sell: VersionedTransaction,
  ): Promise<{ buy: import("@solana/web3.js").AddressLookupTableAccount[]; sell: import("@solana/web3.js").AddressLookupTableAccount[] } | null> {
    const need = [...(buy.message.addressTableLookups ?? []), ...(sell.message.addressTableLookups ?? [])];
    if (!need.length) return { buy: [], sell: [] };
    if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) return null;
    const conn = rpcConnection(this.rpcUrl);
    const loaded = new Map<string, import("@solana/web3.js").AddressLookupTableAccount>();
    for (const lookup of need) {
      const key = lookup.accountKey.toBase58();
      if (loaded.has(key)) continue;
      const got = await conn.getAddressLookupTable(lookup.accountKey);
      if (!got.value) return null;
      loaded.set(key, got.value);
    }
    const pick = (tx: VersionedTransaction) =>
      (tx.message.addressTableLookups ?? []).map((l) => loaded.get(l.accountKey.toBase58())!);
    return { buy: pick(buy), sell: pick(sell) };
  }

  private async guardSwapTx(
    tx: VersionedTransaction,
    payer?: PublicKey,
  ): Promise<{ ok: true; accountKeys: import("@solana/web3.js").PublicKey[] } | { ok: false; error: string }> {
    const our = payer ?? this.keypair?.publicKey;
    if (!our) return { ok: false, error: "tx: no wallet" };
    const lookups = tx.message.addressTableLookups ?? [];
    const tables = [];
    if (lookups.length) {
      if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) {
        return { ok: false, error: "tx: cannot resolve address lookup tables (fail closed)" };
      }
      const conn = rpcConnection(this.rpcUrl);
      for (const lookup of lookups) {
        const loaded = await conn.getAddressLookupTable(lookup.accountKey);
        if (!loaded.value) {
          return {
            ok: false,
            error: `tx: lookup table ${lookup.accountKey.toBase58()} missing (fail closed)`,
          };
        }
        tables.push(loaded.value);
      }
    }
    const accountKeys = accountKeysFromLoadedMessage(tx, tables);
    if (!accountKeys) return { ok: false, error: "tx: could not resolve account keys (fail closed)" };
    return inspectSwapInstructions({
      tx,
      accountKeys,
      ourPubkey: our,
      allowlist: this.cfg.risk.solanaProgramAllowlist ?? [],
    });
  }

  private async signatureOutcome(sig: string): Promise<"success" | "failed" | "pending"> {
    if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) return "pending";
    try {
      const conn = rpcConnection(this.rpcUrl);
      const res = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const st = res.value?.[0];
      if (!st) return "pending";
      if (st.err) return "failed";
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "success";
      return "pending";
    } catch {
      return "pending";
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
