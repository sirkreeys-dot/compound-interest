/**
 * Validate a Jupiter Swap API v2 /order response + assembled VersionedTransaction
 * BEFORE signing. A compromised API / MITM must not be able to drain the wallet
 * via an arbitrary fee payer or mismatched mints/amounts.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export interface JupiterOrderFields {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  taker?: string | null;
  transaction?: string | null;
  requestId?: string;
  errorCode?: number;
  errorMessage?: string;
  inUsdValue?: number;
  outUsdValue?: number;
}

export type JupiterValidationOk = { ok: true; tx: VersionedTransaction };
export type JupiterValidationErr = { ok: false; error: string };
export type JupiterValidationResult = JupiterValidationOk | JupiterValidationErr;

function sameMint(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

export function validateJupiterOrder(opts: {
  order: JupiterOrderFields;
  expectedInputMint: string;
  expectedOutputMint: string;
  expectedInAmount: string;
  maxSlippageBps: number;
  ourPubkey: PublicKey;
  /** When set, refuse buys whose quote outUsd is worse than this vs sellUsd. */
  sellUsd?: number;
  outUsd?: number;
  maxChaseBps?: number;
}): JupiterValidationResult {
  const { order, expectedInputMint, expectedOutputMint, expectedInAmount, maxSlippageBps, ourPubkey } =
    opts;

  if (!order.transaction || order.transaction.length < 16) {
    return {
      ok: false,
      error: `No usable Jupiter transaction: ${order.errorMessage ?? order.errorCode ?? "empty"}`,
    };
  }

  if (!order.inputMint || !sameMint(order.inputMint, expectedInputMint)) {
    return {
      ok: false,
      error: `Jupiter inputMint mismatch: got ${order.inputMint ?? "?"} want ${expectedInputMint}`,
    };
  }
  if (!order.outputMint || !sameMint(order.outputMint, expectedOutputMint)) {
    return {
      ok: false,
      error: `Jupiter outputMint mismatch: got ${order.outputMint ?? "?"} want ${expectedOutputMint}`,
    };
  }
  if (!order.inAmount || order.inAmount !== expectedInAmount) {
    return {
      ok: false,
      error: `Jupiter inAmount mismatch: got ${order.inAmount ?? "?"} want ${expectedInAmount}`,
    };
  }
  if (!order.outAmount || !/^\d+$/.test(order.outAmount) || BigInt(order.outAmount) <= 0n) {
    return { ok: false, error: `Jupiter outAmount missing or zero: ${order.outAmount ?? "?"}` };
  }
  if (order.slippageBps != null && Number.isFinite(order.slippageBps)) {
    if (order.slippageBps > maxSlippageBps) {
      return {
        ok: false,
        error: `Jupiter slippageBps ${order.slippageBps} > max ${maxSlippageBps}`,
      };
    }
  } else if (
    !order.otherAmountThreshold ||
    !/^\d+$/.test(order.otherAmountThreshold)
  ) {
    // Missing slippageBps used to silently skip the check — require a min-out threshold instead.
    return {
      ok: false,
      error: "Jupiter order missing slippageBps and otherAmountThreshold — refusing to sign",
    };
  }

  // Enforce min-out vs quoted outAmount within maxSlippageBps (defense when API lies about slippageBps).
  if (
    order.otherAmountThreshold &&
    /^\d+$/.test(order.otherAmountThreshold) &&
    order.outAmount &&
    /^\d+$/.test(order.outAmount)
  ) {
    const out = BigInt(order.outAmount);
    const minOut = BigInt(order.otherAmountThreshold);
    if (out > 0n) {
      if (minOut > out) {
        return {
          ok: false,
          error: `Jupiter otherAmountThreshold ${minOut} > outAmount ${out}`,
        };
      }
      const slipBps = Number(((out - minOut) * 10_000n) / out);
      if (slipBps > maxSlippageBps) {
        return {
          ok: false,
          error: `Jupiter implied slippage ${slipBps}bps from otherAmountThreshold > max ${maxSlippageBps}`,
        };
      }
    }
  }
  if (order.taker) {
    try {
      if (!new PublicKey(order.taker).equals(ourPubkey)) {
        return {
          ok: false,
          error: `Jupiter taker ${order.taker} != our wallet`,
        };
      }
    } catch {
      return { ok: false, error: `Jupiter taker not a valid pubkey: ${order.taker}` };
    }
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
        error: `chase_limit: quote loss ${lossBps}bps > maxChaseBps ${opts.maxChaseBps} (sellUsd=${opts.sellUsd} outUsd=${opts.outUsd})`,
      };
    }
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  } catch (e) {
    return {
      ok: false,
      error: `Jupiter transaction deserialize failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const feePayerCheck = validateVersionedTxFeePayer(tx, ourPubkey);
  if (!feePayerCheck.ok) return feePayerCheck;

  return { ok: true, tx };
}

export function validateVersionedTxFeePayer(
  tx: VersionedTransaction,
  ourPubkey: PublicKey,
): JupiterValidationResult {
  try {
    const keys = tx.message.getAccountKeys();
    const feePayer = keys.get(0);
    if (!feePayer) {
      return { ok: false, error: "Transaction has no fee payer account" };
    }
    if (!feePayer.equals(ourPubkey)) {
      return {
        ok: false,
        error: `Refusing to sign: fee payer ${feePayer.toBase58()} != our wallet ${ourPubkey.toBase58()}`,
      };
    }
    // Require that we are among the required signers (first numRequiredSignatures accounts)
    const nSigners = tx.message.header.numRequiredSignatures;
    if (nSigners < 1) {
      return { ok: false, error: "Transaction requires no signatures — suspicious" };
    }
    let weSign = false;
    for (let i = 0; i < nSigners; i++) {
      const k = keys.get(i);
      if (k && k.equals(ourPubkey)) {
        weSign = true;
        break;
      }
    }
    if (!weSign) {
      return { ok: false, error: "Our wallet is not a required signer on this transaction" };
    }
    return { ok: true, tx };
  } catch (e) {
    return {
      ok: false,
      error: `TX fee-payer validation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
