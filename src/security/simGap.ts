/** Compare the /order out amount with the round-trip buy leg. Integer math, no floats. */
export function outAmountDiverged(quotedOut: string, simBuyOut: string, slippageBps: number): boolean {
  if (!/^\d+$/.test(quotedOut) || !/^\d+$/.test(simBuyOut)) return true;
  const quoted = BigInt(quotedOut);
  const simulated = BigInt(simBuyOut);
  if (quoted === 0n) return true;
  const diff = quoted > simulated ? quoted - simulated : simulated - quoted;
  const bps = BigInt(Number.isSafeInteger(slippageBps) && slippageBps > 0 ? slippageBps : 0);
  return diff * 10_000n > quoted * bps;
}

/** One re-quote after an expired blockhash. A second expiry aborts. Never a blind resend. */
export function afterBlockhashCheck(attempt: number, blockhashValid: boolean): "sign" | "requote" | "abort" {
  if (blockhashValid) return "sign";
  if (attempt < 1) return "requote";
  return "abort";
}

export function sameMessageBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
