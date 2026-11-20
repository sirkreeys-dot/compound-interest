import { Connection, type Commitment } from "@solana/web3.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timeout plus a short exponential backoff. Retries network errors, 429, and 5xx.
 * State-changing posts (Jupiter /execute, Base send) must pass retries: 0.
 */
export async function fetchRetry(
  input: string | URL,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const retries = opts.retries ?? 2;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchTimeout(input, init, timeoutMs, fetchImpl);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(Math.min(4_000, 200 * 2 ** attempt));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(Math.min(4_000, 200 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}

export const HTTP_TIMEOUT_MS = 10_000;
export const QUOTE_TIMEOUT_MS = 10_000;
export const EXECUTE_TIMEOUT_MS = 20_000;
export const RPC_TIMEOUT_MS = 12_000;

function rpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return fetchRetry(url, init, { timeoutMs: RPC_TIMEOUT_MS, retries: 2 });
}

/** Solana RPC connection whose HTTP calls time out and retry a bounded number of times. */
export function rpcConnection(url: string, commitment: Commitment = "confirmed"): Connection {
  return new Connection(url, {
    commitment,
    disableRetryOnRateLimit: true,
    fetch: rpcFetch,
  });
}
