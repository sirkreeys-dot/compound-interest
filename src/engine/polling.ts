/** REST /v2/alerts is a credit-cost fallback, not a second primary feed. */
export function shouldPollRest(opts: {
  enabled: boolean;
  onlyWhenWsDown: boolean;
  wsHealthy: boolean;
}): boolean {
  if (!opts.enabled) return false;
  if (opts.onlyWhenWsDown && opts.wsHealthy) return false;
  return true;
}
