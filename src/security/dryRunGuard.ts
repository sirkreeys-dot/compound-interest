/**
 * The only switch for live signing and sending is the DRY_RUN environment
 * variable. Unset or any value other than "false" / "0" refuses. Config files
 * cannot turn it off.
 */
export function liveTradingEnabled(): boolean {
  const raw = process.env.DRY_RUN?.trim().toLowerCase();
  return raw === "false" || raw === "0";
}

export function assertLiveAllowed(): void {
  if (!liveTradingEnabled()) {
    throw new Error("DRY_RUN guard: refusing to build, sign, or send a transaction");
  }
}
