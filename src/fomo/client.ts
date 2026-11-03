import { log } from "../utils/logger.js";
import { parseAlertsRestBody } from "./adapter.js";
import type { NormalizedAlert } from "../types.js";

const BASE = "https://api.fomoapi.io";

export class FomoRestClient {
  constructor(private readonly apiKey: string) {}

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    let url: string;
    if (path.startsWith("http")) {
      // Prevent SSRF: only our FOMO HTTPS API host
      let parsed: URL;
      try {
        parsed = new URL(path);
      } catch {
        throw new Error("FOMO client: invalid absolute URL");
      }
      if (parsed.protocol !== "https:" || parsed.host !== "api.fomoapi.io") {
        throw new Error(`FOMO client: refused non-allowlisted URL host ${parsed.host}`);
      }
      url = parsed.toString();
    } else {
      if (!path.startsWith("/")) throw new Error("FOMO client: path must start with /");
      url = `${BASE}${path}`;
    }
    const res = await fetch(url, { headers: this.headers() });
    const credits = res.headers.get("x-credits-remaining");
    if (credits) log.debug(`FOMO credits remaining: ${credits}`);
    if (res.status === 401) throw new Error("FOMO API 401 — invalid or missing API key");
    if (res.status === 402) throw new Error("FOMO API 402 — credits exhausted (see https://fomoapi.io/pricing)");
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FOMO API ${res.status}: ${text.slice(0, 300).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")}`);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<unknown> {
    return this.getJson("/health");
  }

  async me(): Promise<unknown> {
    return this.getJson("/v2/me");
  }

  async leaderboard(window: "24h" | "7d" | "30d" | "all" = "24h", limit = 20): Promise<unknown> {
    return this.getJson(`/v2/leaderboard/${window}?limit=${limit}`);
  }

  async user(handleOrId: string): Promise<unknown> {
    return this.getJson(`/v2/users/${encodeURIComponent(handleOrId)}`);
  }

  async positions(handleOrId: string): Promise<unknown> {
    return this.getJson(`/v2/users/${encodeURIComponent(handleOrId)}/positions`);
  }

  async balances(handleOrId: string, chain?: string): Promise<unknown> {
    const q = chain ? `?chain=${encodeURIComponent(chain)}` : "";
    return this.getJson(`/v2/users/${encodeURIComponent(handleOrId)}/balances${q}`);
  }

  async alerts(opts: {
    since?: string;
    limit?: number;
    type?: string;
    chain?: string;
  } = {}): Promise<NormalizedAlert[]> {
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.type) params.set("type", opts.type);
    if (opts.chain) params.set("chain", opts.chain);
    const qs = params.toString();
    const body = await this.getJson(`/v2/alerts${qs ? `?${qs}` : ""}`);
    return parseAlertsRestBody(body);
  }
}
