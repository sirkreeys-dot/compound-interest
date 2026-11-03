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
      this.publicClient = createPublicClient({ chain: base, transport: http(env.baseRpcUrl) });
      this.walletClient = createWalletClient({
        account: this.account,
        chain: base,
        transport: http(env.baseRpcUrl),
      });
    } else {
      this.account = null;
      this.publicClient = createPublicClient({ chain: base, transport: http(env.baseRpcUrl) });
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

      const quoteRes = await fetch(`${ZEROX}/swap/allowance-holder/quote?${params}`, {
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
