/** Outbound fetch with a hard timeout. A hung call must not hold a token lock forever. */
export async function fetchTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const QUOTE_TIMEOUT_MS = 10_000;
export const EXECUTE_TIMEOUT_MS = 20_000;
