/**
 * Validate a 0x Swap API v2 allowance-holder quote BEFORE sending.
 * Only the documented AllowanceHolder contract may be the tx target / spender.
 */
import { ZEROX_NATIVE_ETH } from "../utils/money.js";

/** Official 0x AllowanceHolder for Cancun-hardfork chains including Base (8453). */
export const ZEROX_ALLOWANCE_HOLDER_CANCUN =
  "0x0000000000001fF3684f28c67538d4D072C22734";

export interface ZeroXQuoteFields {
  buyAmount?: string;
  sellAmount?: string;
  buyToken?: string;
  sellToken?: string;
  minBuyAmount?: string;
  liquidityAvailable?: boolean;
  transaction?: { to?: string; data?: string; value?: string; gas?: string };
  issues?: { allowance?: { spender?: string } | null };
}

function eqAddr(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type ZeroXValidation =
  | { ok: true }
  | { ok: false; error: string };

export function validateZeroXQuote(opts: {
  quote: ZeroXQuoteFields;
  expectedSellToken: string;
  expectedBuyToken: string;
  expectedSellAmount: string;
  /** Allow sellAmount in quote to be slightly below request (0x volume fee). Default 200 bps. */
  maxSellAmountHaircutBps?: number;
  sellUsd?: number;
  outUsd?: number;
  maxChaseBps?: number;
}): ZeroXValidation {
  const { quote, expectedSellToken, expectedBuyToken, expectedSellAmount } = opts;
  const haircutBps = opts.maxSellAmountHaircutBps ?? 200;

  if (quote.liquidityAvailable === false) {
    return { ok: false, error: "0x quote: liquidityAvailable=false" };
  }

  if (quote.sellToken && !eqAddr(quote.sellToken, expectedSellToken)) {
    return {
      ok: false,
      error: `0x sellToken mismatch: got ${quote.sellToken} want ${expectedSellToken}`,
    };
  }
  if (quote.buyToken && !eqAddr(quote.buyToken, expectedBuyToken)) {
    return {
      ok: false,
      error: `0x buyToken mismatch: got ${quote.buyToken} want ${expectedBuyToken}`,
    };
  }

  if (!quote.buyAmount || !/^\d+$/.test(quote.buyAmount) || BigInt(quote.buyAmount) <= 0n) {
    return { ok: false, error: `0x buyAmount missing or zero: ${quote.buyAmount ?? "?"}` };
  }

  if (quote.sellAmount && /^\d+$/.test(quote.sellAmount) && /^\d+$/.test(expectedSellAmount)) {
    const got = BigInt(quote.sellAmount);
    const want = BigInt(expectedSellAmount);
    if (got > want) {
      return {
        ok: false,
        error: `0x sellAmount ${got} exceeds requested ${want}`,
      };
    }
    if (want > 0n) {
      const cutBps = Number(((want - got) * 10_000n) / want);
      if (cutBps > haircutBps) {
        return {
          ok: false,
          error: `0x sellAmount haircut ${cutBps}bps > ${haircutBps}bps`,
        };
      }
    }
  }

  const tx = quote.transaction;
  if (!tx?.to || !tx.data || tx.data === "0x") {
    return { ok: false, error: "0x quote missing transaction.to/data" };
  }
  if (!eqAddr(tx.to, ZEROX_ALLOWANCE_HOLDER_CANCUN)) {
    return {
      ok: false,
      error: `Refusing 0x tx.to ${tx.to} — not AllowanceHolder ${ZEROX_ALLOWANCE_HOLDER_CANCUN}`,
    };
  }

  const spender = quote.issues?.allowance?.spender;
  if (spender && !eqAddr(spender, ZEROX_ALLOWANCE_HOLDER_CANCUN)) {
    return {
      ok: false,
      error: `Refusing 0x allowance spender ${spender} — not AllowanceHolder`,
    };
  }

  const isNative = eqAddr(expectedSellToken, ZEROX_NATIVE_ETH);
  if (isNative) {
    const value = tx.value ? BigInt(tx.value) : 0n;
    const expect = BigInt(quote.sellAmount ?? expectedSellAmount);
    if (value !== expect) {
      return {
        ok: false,
        error: `0x native value ${value} != sellAmount ${expect}`,
      };
    }
  } else if (tx.value && BigInt(tx.value) !== 0n) {
    return { ok: false, error: `0x ERC20 swap must have value=0, got ${tx.value}` };
  }

  if (
    opts.maxChaseBps != null &&
    opts.maxChaseBps > 0 &&
    opts.sellUsd != null &&
    opts.sellUsd > 0 &&
    opts.outUsd != null &&
    opts.outUsd > 0
  ) {
    const lossBps = Math.round((1 - opts.outUsd / opts.sellUsd) * 10_000);
    if (lossBps > opts.maxChaseBps) {
      return {
        ok: false,
        error: `chase_limit: quote loss ${lossBps}bps > maxChaseBps ${opts.maxChaseBps}`,
      };
    }
  }

  return { ok: true };
}
