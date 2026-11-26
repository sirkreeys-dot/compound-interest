import { QUOTE_TIMEOUT_MS, fetchRetry } from "../utils/http.js";

export type JupiterPriority = "buy" | "sell";

/** Shared by every Jupiter call. Sells are served before queued buys. */
export class JupiterLimiter {
  private tokens: number;
  private readonly high: Array<() => void> = [];
  private readonly low: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly perSec: number, initialTokens?: number) {
    const cap = Math.max(1, Math.floor(perSec));
    this.tokens = initialTokens ?? cap;
  }

  acquire(priority: JupiterPriority): Promise<void> {
    this.arm();
    if (priority === "sell" && this.tokens > 0 && this.high.length === 0) {
      this.tokens--;
      return Promise.resolve();
    }
    if (priority === "buy" && this.tokens > 0 && this.high.length === 0) {
      this.tokens--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      (priority === "sell" ? this.high : this.low).push(resolve);
      this.drain();
      this.touchTimer();
    });
  }

  /** Test helper: add one token and serve the highest-priority waiter. */
  releaseToken(): void {
    this.tokens++;
    this.drain();
  }

  private arm(): void {
    if (this.timer) return;
    const gap = Math.max(1, Math.ceil(1000 / Math.max(1, this.perSec)));
    this.timer = setInterval(() => {
      this.tokens = Math.min(Math.max(1, Math.floor(this.perSec)), this.tokens + 1);
      this.drain();
    }, gap);
    this.touchTimer();
  }

  /** Keep the process alive only while a call is waiting for a slot. */
  private touchTimer(): void {
    if (!this.timer) return;
    if (this.high.length > 0 || this.low.length > 0) this.timer.ref?.();
    else this.timer.unref?.();
  }

  private drain(): void {
    while (this.tokens > 0 && (this.high.length > 0 || this.low.length > 0)) {
      const queue = this.high.length > 0 ? this.high : this.low;
      this.tokens--;
      const next = queue.shift();
      next?.();
    }
    this.touchTimer();
  }
}

let singleton: JupiterLimiter | null = null;

export function configureJupiterLimiter(perSec: number): void {
  singleton = new JupiterLimiter(Number.isFinite(perSec) && perSec > 0 ? perSec : 2);
}

export function getJupiterLimiter(): JupiterLimiter {
  if (!singleton) singleton = new JupiterLimiter(2);
  return singleton;
}

export function jupiterHeaders(apiKey: string | undefined, extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(extra)) {
    for (const [key, value] of extra) headers[key] = value;
  } else if (extra) {
    Object.assign(headers, extra);
  }
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

export function isJupiterRateLimit(error: string | undefined): boolean {
  if (!error) return false;
  return /\b429\b/.test(error) || /too many requests/i.test(error);
}

/** Retry-After when it is a delay or a date, otherwise 1s, 2s, 4s. Capped at 8s. */
export function rateLimitBackoffMs(attempt: number, retryAfter: string | null, now = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(8_000, Math.round(seconds * 1000));
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) return Math.min(8_000, Math.max(0, when - now));
  }
  return Math.min(4_000, 1_000 * 2 ** Math.max(0, attempt));
}

export type LadderStep = "success" | "in-flight" | "retry-same-rung" | "next-rung";

/** A 429 stays on this slippage rung until the bounded attempts are used. */
export function ladderStep(opts: {
  ok: boolean;
  inFlight: boolean;
  error?: string;
  rateAttempts: number;
  maxRateAttempts?: number;
}): LadderStep {
  if (opts.ok) return "success";
  if (opts.inFlight) return "in-flight";
  const max = opts.maxRateAttempts ?? 3;
  if (isJupiterRateLimit(opts.error) && opts.rateAttempts + 1 < max) return "retry-same-rung";
  return "next-rung";
}

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setRateLimitSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function sleepRateLimit(ms: number): Promise<void> {
  return sleepImpl(ms);
}

const RATE_LIMIT_ATTEMPTS = 5;
const QUOTE_CACHE_MS = 4_000;

type CachedGet = { at: number; status: number; body: string };
const getCache = new Map<string, CachedGet>();

function requestBody(body: RequestInit["body"]): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  return "";
}

/** Idempotent quote, price, and swap-instructions reads. Never a signed execute. */
export function cacheableJupiterRequest(url: string, method: string, body: string): boolean {
  if (url.includes("/execute")) return false;
  if (body.includes("signedTransaction")) return false;
  if (method === "GET" && (url.includes("/quote") || url.includes("/price/"))) return true;
  if (method === "POST" && url.includes("/swap-instructions")) return true;
  return false;
}

/** Add up to 250ms so retries do not line up. The base delay stays capped at 8s. */
export function backoffWithJitter(baseMs: number, rand = Math.random()): number {
  const jitter = Math.floor(Math.max(0, Math.min(1, rand)) * 250);
  return Math.min(8_000, baseMs + jitter);
}

export function clearJupiterCacheForTests(): void {
  getCache.clear();
}

export async function jupiterFetch(
  input: string,
  init: RequestInit,
  opts: {
    apiKey?: string;
    priority: JupiterPriority;
    fetchImpl?: typeof fetch;
    /** Sells and /execute leave 429s unretried so a signed transaction is not sent again. */
    retry429?: boolean;
    limiter?: JupiterLimiter;
    timeoutMs?: number;
  },
): Promise<Response> {
  const limiter = opts.limiter ?? getJupiterLimiter();
  const headers = jupiterHeaders(opts.apiKey, init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  const body = requestBody(init.body);
  const cacheKey = `${method} ${input} ${body}`;
  const useCache =
    cacheableJupiterRequest(input, method, body) &&
    (opts.fetchImpl == null || opts.fetchImpl === globalThis.fetch);
  if (useCache) {
    const hit = getCache.get(cacheKey);
    if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) {
      return new Response(hit.body, { status: hit.status });
    }
  }
  const attempts = opts.retry429 === false ? 1 : RATE_LIMIT_ATTEMPTS;
  let last: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await limiter.acquire(opts.priority);
    last = await fetchRetry(
      input,
      { ...init, method, headers },
      {
        timeoutMs: opts.timeoutMs ?? QUOTE_TIMEOUT_MS,
        retries: 2,
        fetchImpl: opts.fetchImpl,
        retry429: false,
      },
    );
    if (last.status !== 429 || attempt === attempts - 1) break;
    const base = rateLimitBackoffMs(attempt, last.headers.get("retry-after"));
    await sleepRateLimit(backoffWithJitter(base));
  }
  const res = last ?? new Response("", { status: 429 });
  if (useCache && res.status === 200) {
    const body = await res.text();
    getCache.set(cacheKey, { at: Date.now(), status: res.status, body });
    return new Response(body, { status: res.status });
  }
  return res;
}
