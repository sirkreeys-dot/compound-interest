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
import { inspectSolanaMint, type TokenSafetyMode } from "../security/tokenSafety.js";
import type { Store } from "../store/db.js";
import type { AppConfig } from "../types.js";
import { log } from "../utils/logger.js";
import { usdToTokenRaw } from "../utils/money.js";
import type { PriceService } from "../utils/prices.js";
import type { Executor, SwapRequest, SwapResult } from "./types.js";

const JUP_BASE = "https://api.jup.ag/swap/v2";

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
    const safety = await this.checkTokenSafety(req.buyToken);
    if (safety?.blocked) {
      return {
        ok: false,
        dryRun: req.dryRun,
        error: `token_safety: ${safety.blockReason ?? "blocked"} (${safety.warnings.join("; ")})`,
        pendingId: req.pendingId,
      };
    }
    if (safety && safety.warnings.length) {
      log.warn(`tokenSafety ${req.buyToken}: ${safety.warnings.join("; ")}`);
    }
    return this.swap({ ...req, sellToken, buyToken: req.buyToken }, "buy");
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

  private async checkTokenSafety(mint: string) {
    const mode = (this.cfg.filters.tokenSafety ?? "block") as TokenSafetyMode;
    if (mode === "off") return null;
    if (!this.rpcUrl || /127\.0\.0\.1|localhost/i.test(this.rpcUrl)) return null;
    return inspectSolanaMint(this.rpcUrl, mint, {
      mode,
      blockFreezeAuthority: this.cfg.filters.blockFreezeAuthority ?? true,
      blockTransferHooks: this.cfg.filters.blockTransferHooks ?? true,
    });
  }

  private async swap(req: SwapRequest, side: "buy" | "sell"): Promise<SwapResult> {
    let pendingId = req.pendingId;
    try {
      if (!req.dryRun && !this.keypair) {
        return { ok: false, dryRun: false, error: "LIVE mode requires SOLANA_PRIVATE_KEY", pendingId };
      }

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

      const params = new URLSearchParams({
        inputMint: req.sellToken,
        outputMint: req.buyToken,
        amount,
        slippageBps: String(req.slippageBps),
      });
      if (this.keypair && !req.dryRun) {
        params.set("taker", this.keypair.publicKey.toBase58());
      }

      const headers: Record<string, string> = {};
      if (this.apiKey) headers["x-api-key"] = this.apiKey;

      const orderRes = await fetch(`${JUP_BASE}/order?${params}`, { headers });
      if (!orderRes.ok) {
        const t = await orderRes.text();
        return {
          ok: false,
          dryRun: req.dryRun,
          error: redactSecrets(`Jupiter /order ${orderRes.status}: ${t.slice(0, 200)}`),
          pendingId,
        };
      }
      const order = (await orderRes.json()) as {
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
      };

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

      if (req.dryRun) {
        if (
          this.cfg.risk.maxChaseBps > 0 &&
          req.sellUsd > 0 &&
          outUsd != null &&
          outUsd > 0
        ) {
          const lossBps = Math.round((1 - outUsd / req.sellUsd) * 10_000);
          if (lossBps > this.cfg.risk.maxChaseBps) {
            return {
              ok: false,
              dryRun: true,
              error: `chase_limit: quote loss ${lossBps}bps > maxChaseBps ${this.cfg.risk.maxChaseBps}`,
              quoteSummary: summary,
              outUsd,
              outAmountRaw: order.outAmount,
              inAmountRaw: order.inAmount ?? amount,
              pendingId,
            };
          }
        }
        return {
          ok: true,
          dryRun: true,
          outAmountRaw: order.outAmount,
          inAmountRaw: order.inAmount ?? amount,
          outUsd,
          quoteSummary: summary,
          pendingId,
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
