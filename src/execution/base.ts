/**
 * Base swaps via 0x Swap API v2. Native ETH uses 0xEeee… sentinel.
 * Sizing uses PriceService (0x price) — refuses if no fresh ETH price.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { EnvConfig } from "../config.js";
import type { AppConfig } from "../types.js";
import { log } from "../utils/logger.js";
import { usdToTokenRaw, ZEROX_NATIVE_ETH } from "../utils/money.js";
import type { PriceService } from "../utils/prices.js";
import { fetchRetry } from "../utils/http.js";
import {
  baseHolderCheck,
  baseLiquidityUsd,
  classifyBaseSellSim,
  judgeBaseBalanceDiff,
  judgeBaseControls,
  nativeBalanceFromTrace,
  wordAddress,
  wordBool,
} from "../security/baseChecks.js";
import { redactSecrets } from "../security/redact.js";
import { validateZeroXQuote, ZEROX_ALLOWANCE_HOLDER_CANCUN } from "../security/zeroxTx.js";
import type { Executor, SwapRequest, SwapResult } from "./types.js";

const ZEROX = "https://api.0x.org";
const CHAIN_ID = 8453;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export class BaseExecutor implements Executor {
  readonly chain = "base" as const;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly apiKey: string;
  private readonly cfg: AppConfig;
  private readonly prices: PriceService;

  constructor(env: EnvConfig, cfg: AppConfig, prices: PriceService) {
    this.cfg = cfg;
    this.apiKey = env.zeroXApiKey;
    this.prices = prices;
    if (env.basePrivateKey) {
      const pk = env.basePrivateKey.startsWith("0x")
        ? (env.basePrivateKey as Hex)
        : (`0x${env.basePrivateKey}` as Hex);
      this.account = privateKeyToAccount(pk);
      this.publicClient = createPublicClient({
        chain: base,
        transport: http(env.baseRpcUrl, { timeout: 12_000, retryCount: 2, retryDelay: 300 }),
      });
      this.walletClient = createWalletClient({
        account: this.account,
        chain: base,
        transport: http(env.baseRpcUrl, { timeout: 12_000, retryCount: 0 }),
      });
    } else {
      this.account = null;
      this.publicClient = createPublicClient({
        chain: base,
        transport: http(env.baseRpcUrl, { timeout: 12_000, retryCount: 2, retryDelay: 300 }),
      });
      this.walletClient = null;
    }
  }

  ready(): boolean {
    return this.account !== null && Boolean(this.apiKey);
  }

  address(): string | null {
    return this.account?.address ?? null;
  }

  async buyToken(req: SwapRequest): Promise<SwapResult> {
    const sellToken = this.cfg.quote.preferStableBuys
      ? this.cfg.quote.baseStable
      : ZEROX_NATIVE_ETH;
    return this.swap({ ...req, sellToken, buyToken: req.buyToken });
  }

  async sellToken(req: SwapRequest): Promise<SwapResult> {
    return this.swap({
      ...req,
      sellToken: req.sellToken,
      buyToken: ZEROX_NATIVE_ETH,
    });
  }

  private async swap(req: SwapRequest): Promise<SwapResult> {
    if (!req.dryRun && !this.ready()) {
      return {
        ok: false,
        dryRun: false,
        error: "LIVE mode requires BASE_PRIVATE_KEY and ZEROX_API_KEY",
      };
    }
    if (!this.apiKey) {
      return { ok: false, dryRun: req.dryRun, error: "ZEROX_API_KEY missing" };
    }
    try {
      let sellAmount = req.sellAmountRaw;
      if (!sellAmount) {
        sellAmount = (await this.usdToRaw(req.sellToken, req.sellUsd)) ?? undefined;
      }
      if (!sellAmount || sellAmount === "0") {
        return {
          ok: false,
          dryRun: req.dryRun,
          error:
            "Could not size sell amount — need fresh ETH/USDC price or sellAmountRaw (refused)",
        };
      }

      const params = new URLSearchParams({
        chainId: String(CHAIN_ID),
        sellToken: req.sellToken,
        buyToken: req.buyToken,
        sellAmount,
        slippageBps: String(req.slippageBps),
      });
      if (this.account && !req.dryRun) params.set("taker", this.account.address);

      const quoteRes = await fetchRetry(`${ZEROX}/swap/allowance-holder/quote?${params}`, {
        headers: {
          "0x-api-key": this.apiKey,
          "0x-version": "v2",
        },
      });
      if (!quoteRes.ok) {
        const t = await quoteRes.text();
        return {
          ok: false,
          dryRun: req.dryRun,
          error: redactSecrets(`0x quote ${quoteRes.status}: ${t.slice(0, 200)}`),
        };
      }
      const quote = (await quoteRes.json()) as {
        buyAmount?: string;
        sellAmount?: string;
        buyToken?: string;
        sellToken?: string;
        minBuyAmount?: string;
        liquidityAvailable?: boolean;
        transaction?: { to?: string; data?: string; value?: string; gas?: string };
        issues?: { allowance?: { spender?: string } | null };
      };

      const summary = `0x buyAmount=${quote.buyAmount ?? "?"} sellAmount=${quote.sellAmount ?? sellAmount}`;
      const outUsd =
        (
          await this.prices.rawOutToUsd({
            chain: "base",
            buyToken: req.buyToken,
            outAmountRaw: quote.buyAmount ?? "",
          })
        )?.usd ?? undefined;

      const guard = await this.assessBase(req, quote, sellAmount);
      if (guard) {
        return { ok: false, dryRun: req.dryRun, error: guard, quoteSummary: summary, outUsd };
      }

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
              outAmountRaw: quote.buyAmount,
              inAmountRaw: quote.sellAmount ?? sellAmount,
            };
          }
        }
        return {
          ok: true,
          dryRun: true,
          outAmountRaw: quote.buyAmount,
          inAmountRaw: quote.sellAmount ?? sellAmount,
          outUsd,
          quoteSummary: summary,
        };
      }

      const tx = quote.transaction;
      const validated = validateZeroXQuote({
        quote: {
          ...quote,
          sellToken: quote.sellToken ?? req.sellToken,
          buyToken: quote.buyToken ?? req.buyToken,
        },
        expectedSellToken: req.sellToken,
        expectedBuyToken: req.buyToken,
        expectedSellAmount: sellAmount,
        sellUsd: req.sellUsd,
        outUsd,
        maxChaseBps: this.cfg.risk.maxChaseBps,
      });
      if (!validated.ok) {
        return {
          ok: false,
          dryRun: false,
          error: redactSecrets(validated.error),
          quoteSummary: summary,
        };
      }
      if (!tx?.to || !tx.data) {
        return {
          ok: false,
          dryRun: false,
          error: "0x quote missing transaction",
          quoteSummary: summary,
        };
      }

      const spender = quote.issues?.allowance?.spender ?? ZEROX_ALLOWANCE_HOLDER_CANCUN;
      const isNative = req.sellToken.toLowerCase() === ZEROX_NATIVE_ETH.toLowerCase();
      if (!isNative) {
        await this.ensureAllowance(
          req.sellToken as Address,
          ZEROX_ALLOWANCE_HOLDER_CANCUN as Address,
          BigInt(sellAmount),
        );
      }
      void spender;

      try {
        await this.publicClient!.call({
          account: this.account!.address,
          to: ZEROX_ALLOWANCE_HOLDER_CANCUN as Address,
          data: tx.data as Hex,
          value: tx.value ? BigInt(tx.value) : 0n,
        });
      } catch (e) {
        return {
          ok: false,
          dryRun: false,
          error: redactSecrets(
            `base sim failed (fail closed): ${e instanceof Error ? e.message : String(e)}`,
          ),
          quoteSummary: summary,
        };
      }
      const hash = await this.walletClient!.sendTransaction({
        to: ZEROX_ALLOWANCE_HOLDER_CANCUN as Address,
        data: tx.data as Hex,
        value: tx.value ? BigInt(tx.value) : 0n,
        account: this.account!,
        chain: base,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      return {
        ok: true,
        dryRun: false,
        txHash: hash,
        outAmountRaw: quote.buyAmount,
        inAmountRaw: quote.sellAmount ?? sellAmount,
        outUsd,
        quoteSummary: summary,
      };
    } catch (e) {
      return { ok: false, dryRun: req.dryRun, error: redactSecrets(e instanceof Error ? e.message : String(e)) };
    }
  }

  private async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    if (!this.account || !this.walletClient) return;
    const current = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, spender],
    })) as bigint;
    if (current >= amount) return;
    log.info(`Approving 0x spender ${spender} for token ${token.slice(0, 10)}…`);
    const hash = await this.walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
      account: this.account,
      chain: base,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  private riskyToken(req: SwapRequest): string {
    const stable = this.cfg.quote.baseStable.toLowerCase();
    const sell = req.sellToken.toLowerCase();
    if (sell === ZEROX_NATIVE_ETH.toLowerCase() || sell === stable) return req.buyToken;
    return req.sellToken;
  }

  /** Pre-send checks. Base stays off unless the chain is enabled. */
  private async assessBase(
    req: SwapRequest,
    quote: {
      buyAmount?: string;
      liquidityAvailable?: boolean;
      transaction?: { to?: string; data?: string; value?: string };
    },
    sellAmount: string,
  ): Promise<string | null> {
    if (quote.liquidityAvailable === false) return "base_liquidity: 0x liquidityAvailable=false";
    const minLiq = this.cfg.filters.minLiquidityUsd ?? 0;
    if (minLiq > 0) {
      try {
        const res = await fetchRetry(
          `https://api.dexscreener.com/latest/dex/tokens/${this.riskyToken(req)}`,
          {},
          { timeoutMs: 10_000, retries: 2 },
        );
        const usd = res.ok ? baseLiquidityUsd(await res.json()) : null;
        if (usd == null || usd < minLiq) {
          return `base_liquidity: ${usd ?? "missing"} < min $${minLiq} (SOL/WETH or USDC pairs only)`;
        }
      } catch {
        return "base_liquidity: lookup failed (fail closed)";
      }
    }
    const holders = baseHolderCheck(this.cfg.filters.maxTopHolderBps ?? 0);
    if (holders.blocked) return holders.detail;

    const token = this.riskyToken(req);
    if (token.startsWith("0x") && this.publicClient) {
      const ownerData = await this.readWord(token as Address, "0x8da5cb5b");
      const pausedData = await this.readWord(token as Address, "0x5c975abb");
      const blackData = await this.readWord(
        token as Address,
        (`0xfe575a87${(this.account?.address ?? "0x0000000000000000000000000000000000000000").slice(2).padStart(64, "0")}`) as Hex,
      );
      let code: string | null = null;
      try {
        code = (await this.publicClient.getCode({ address: token as Address })) ?? null;
      } catch {
        code = null;
      }
      const judged = judgeBaseControls({
        owner: wordAddress(ownerData),
        ownerCallFailed: ownerData == null,
        paused: pausedData == null ? null : wordBool(pausedData),
        blacklisted: blackData == null ? null : wordBool(blackData),
        bytecode: code,
      });
      if (judged.blocked) return judged.detail;
    }

    const sellClass = await this.classifySell(req, quote.buyAmount ?? sellAmount);
    if (sellClass === "honeypot") return "base_honeypot: sell eth_call reverted";
    if (sellClass === "no_balance") {
      log.warn(
        "baseSellSim=no_balance: the wallet does not hold this token yet, so eth_call of the sell cannot prove it is sellable. The quote is not treated as proof.",
      );
      if (!req.dryRun) return "base_honeypot: sell simulation had no balance (fail closed)";
    }

    if (!req.dryRun && this.account && this.publicClient) {
      const diff = await this.readBalanceDiff(req, sellAmount, quote);
      if (!diff) {
        return "base_balance_diff_unavailable: RPC did not return a balance diff (fail closed, not sent)";
      }
      if (!diff.ok) return diff.error ?? "base_balance: diff rejected";
    }
    return null;
  }

  private async readWord(to: Address, data: Hex): Promise<string | null> {
    try {
      const out = await this.publicClient.call({ to, data });
      return out.data ?? null;
    } catch {
      return null;
    }
  }

  private async classifySell(req: SwapRequest, amount: string): Promise<"ok" | "no_balance" | "honeypot" | "skipped"> {
    if (!amount || amount === "0" || !this.publicClient) return "skipped";
    const token = this.riskyToken(req);
    let balance = 0n;
    if (token.startsWith("0x")) {
      try {
        const raw = await this.publicClient.readContract({
          address: token as Address,
          abi: [
            {
              name: "balanceOf",
              type: "function",
              stateMutability: "view",
              inputs: [{ name: "account", type: "address" }],
              outputs: [{ type: "uint256" }],
            },
          ] as const,
          functionName: "balanceOf",
          args: [(this.account?.address ?? "0x0000000000000000000000000000000000000000") as Address],
        });
        balance = raw as bigint;
      } catch {
        balance = 0n;
      }
    }
    try {
      const params = new URLSearchParams({
        chainId: String(CHAIN_ID),
        sellToken: token,
        buyToken: ZEROX_NATIVE_ETH,
        sellAmount: amount,
      });
      if (this.account) params.set("taker", this.account.address);
      const res = await fetchRetry(`${ZEROX}/swap/allowance-holder/quote?${params}`, {
        headers: { "0x-api-key": this.apiKey, "0x-version": "v2" },
      }, { timeoutMs: 10_000, retries: 2 });
      if (!res.ok) return req.dryRun ? "no_balance" : "honeypot";
      const q = (await res.json()) as { transaction?: { to?: string; data?: string; value?: string } };
      if (!q.transaction?.to || !q.transaction.data) return req.dryRun ? "no_balance" : "honeypot";
      try {
        await this.publicClient.call({
          account: (this.account?.address ?? "0x0000000000000000000000000000000000000001") as Address,
          to: q.transaction.to as Address,
          data: q.transaction.data as Hex,
          value: q.transaction.value ? BigInt(q.transaction.value) : 0n,
        });
        return "ok";
      } catch (e) {
        return classifyBaseSellSim({
          reverted: true,
          revertText: e instanceof Error ? e.message : String(e),
          tokenBalance: balance,
        });
      }
    } catch {
      return req.dryRun ? "no_balance" : "honeypot";
    }
  }

  private async readBalanceDiff(
    req: SwapRequest,
    sellAmount: string,
    quote: { transaction?: { to?: string; data?: string; value?: string } },
  ): Promise<{ ok: boolean; error?: string } | null> {
    if (!this.account || !this.publicClient || !quote.transaction?.to || !quote.transaction.data) return null;
    try {
      const traced = await this.publicClient.request({
        method: "trace_call" as never,
        params: [
          {
            from: this.account.address,
            to: quote.transaction.to,
            data: quote.transaction.data,
            value: quote.transaction.value ? `0x${BigInt(quote.transaction.value).toString(16)}` : "0x0",
          },
          ["stateDiff"],
          "latest",
        ] as never,
      });
      const native = nativeBalanceFromTrace(traced, this.account.address);
      if (!native) return null;
      const value = quote.transaction.value ? BigInt(quote.transaction.value) : 0n;
      void sellAmount;
      return judgeBaseBalanceDiff({
        nativeBefore: native.before,
        nativeAfter: native.after,
        maxNativeDrop: value + 50_000_000_000_000n,
        tokens: [],
      });
    } catch {
      return null;
    }
  }

  private async usdToRaw(token: string, usd: number): Promise<string | null> {
    if (token.toLowerCase() === this.cfg.quote.baseStable.toLowerCase()) {
      return usdToTokenRaw(usd, 6, 1);
    }
    if (
      token.toLowerCase() === ZEROX_NATIVE_ETH.toLowerCase() ||
      token.toLowerCase() === this.cfg.quote.baseNative.toLowerCase()
    ) {
      const price = await this.prices.getEthUsd();
      log.debug(`ETH USD price $${price.usd} via ${price.source}`);
      return usdToTokenRaw(usd, 18, price.usd);
    }
    return null;
  }
}
