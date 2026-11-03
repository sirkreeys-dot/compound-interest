/**
 * Resolves who to copy: leaderboard top-N (default) or a manual trader list.
 * Keys traders by FOMO userId. Alumni persisted in SQLite across restarts.
 */
import type { AppConfig, ChainName, TraderConfig } from "../types.js";
import type { Store } from "../store/db.js";
import { FomoRestClient } from "../fomo/client.js";
import { log } from "../utils/logger.js";

export interface WatchedTrader extends TraderConfig {
  userId: string;
  handle?: string;
  rank?: number;
  activeForEntries: boolean;
  source: "leaderboard" | "manual";
}

export interface WatchlistChange {
  added: WatchedTrader[];
  removed: WatchedTrader[];
  current: WatchedTrader[];
}

type LeaderboardRow = {
  rank?: number;
  handle?: string;
  userId?: string;
  displayName?: string;
};

type LeaderboardResponse = {
  window?: string;
  traders?: LeaderboardRow[];
  count?: number;
};

export class Watchlist {
  private active: WatchedTrader[] = [];
  private alumni: Map<string, WatchedTrader> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly rest: FomoRestClient | null,
    private readonly onChange?: (change: WatchlistChange) => void | Promise<void>,
    private readonly store?: Store | null,
  ) {}

  listActive(): WatchedTrader[] {
    return [...this.active];
  }

  listAlumni(): WatchedTrader[] {
    return [...this.alumni.values()];
  }

  subscribeKeys(): string[] {
    return this.active.map((t) => t.handle || t.userId).filter(Boolean);
  }

  subscribeKeysWithOpen(openTraderKeys: string[]): string[] {
    const set = new Set(this.subscribeKeys());
    for (const k of openTraderKeys) {
      if (k) set.add(k);
    }
    for (const t of this.alumni.values()) {
      const key = t.handle || t.userId;
      if (
        key &&
        openTraderKeys.some(
          (o) =>
            o.toLowerCase() === key.toLowerCase() ||
            o === t.userId ||
            (t.handle && o.toLowerCase() === t.handle.toLowerCase()),
        )
      ) {
        set.add(key);
      }
    }
    return [...set];
  }

  findActive(alertUserId: string | null, handle: string | null): WatchedTrader | null {
    return this.active.find((t) => matches(t, alertUserId, handle)) ?? null;
  }

  findForClose(alertUserId: string | null, handle: string | null): WatchedTrader | null {
    const a = this.findActive(alertUserId, handle);
    if (a) return a;
    for (const t of this.alumni.values()) {
      if (matches(t, alertUserId, handle)) return t;
    }
    return null;
  }

  async start(): Promise<void> {
    this.loadAlumniFromStore();
    await this.refresh("startup");
    if (this.cfg.traderSource === "leaderboard") {
      const ms = this.cfg.leaderboard.refreshHours * 3600_000;
      this.timer = setInterval(() => {
        void this.refresh("interval");
      }, ms);
      log.info(
        `Leaderboard watchlist refresh every ${this.cfg.leaderboard.refreshHours}h (window=${this.cfg.leaderboard.window} topN=${this.cfg.leaderboard.topN})`,
      );
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private loadAlumniFromStore(): void {
    if (!this.store) return;
    try {
      for (const row of this.store.loadAlumni()) {
        this.alumni.set(row.userId, {
          userId: row.userId,
          handle: row.handle,
          enabled: true,
          chains: row.chains as ChainName[],
          rank: row.rank,
          activeForEntries: false,
          source: row.source,
        });
      }
      if (this.alumni.size) {
        log.info(`Loaded ${this.alumni.size} alumni trader(s) from SQLite`);
      }
    } catch (e) {
      log.warn("Failed to load alumni from SQLite", e);
    }
  }

  private persistAlumni(): void {
    if (!this.store) return;
    try {
      this.store.replaceAlumni(
        [...this.alumni.values()].map((t) => ({
          userId: t.userId,
          handle: t.handle,
          chains: t.chains,
          source: t.source,
          rank: t.rank,
        })),
      );
    } catch (e) {
      log.warn("Failed to persist alumni", e);
    }
  }

  async refresh(reason: string): Promise<WatchlistChange> {
    const prev = [...this.active];
    let next: WatchedTrader[];

    if (this.cfg.traderSource === "manual") {
      next = this.cfg.traders
        .filter((t) => t.enabled)
        .map((t, i) => {
          const userId = t.userId ?? `manual:${(t.handle ?? i).toString().toLowerCase()}`;
          return {
            ...t,
            userId,
            handle: t.handle,
            activeForEntries: true,
            source: "manual" as const,
            chains: t.chains?.length ? t.chains : (["solana", "base"] as ChainName[]),
          };
        });
      for (const t of next) {
        if (t.userId.startsWith("manual:")) {
          log.warn(
            `Manual trader ${t.handle} has no userId — prefer resolving via FOMO and setting userId`,
          );
        }
      }
    } else {
      next = await this.fetchLeaderboardTop();
    }

    const prevIds = new Set(prev.map((t) => t.userId));
    const nextIds = new Set(next.map((t) => t.userId));
    const added = next.filter((t) => !prevIds.has(t.userId));
    const removed = prev.filter((t) => !nextIds.has(t.userId));

    for (const r of removed) {
      this.alumni.set(r.userId, { ...r, activeForEntries: false });
    }
    for (const a of added) {
      this.alumni.delete(a.userId);
    }
    // Drop alumni who somehow reappear as active (already handled) — also
    // drop alumni with no open positions? Keep all until manually cleared;
    // subscribeKeysWithOpen gates sockets.

    this.active = next;
    this.persistAlumni();

    const change: WatchlistChange = { added, removed, current: next };
    log.info(
      `Watchlist refresh (${reason}): ${next.length} active, ${this.alumni.size} alumni` +
        (added.length || removed.length
          ? ` (+${added.length} / -${removed.length})`
          : " (unchanged)"),
    );
    for (const t of next) {
      log.info(`  #${t.rank ?? "?"} ${t.handle ?? "?"} userId=${t.userId}`);
    }

    if (added.length || removed.length || reason === "startup") {
      if (added.length || removed.length) await this.onChange?.(change);
    }
    return change;
  }

  private async fetchLeaderboardTop(): Promise<WatchedTrader[]> {
    if (!this.rest) {
      throw new Error("FOMO_API_KEY required for traderSource=leaderboard");
    }
    const window = this.cfg.leaderboard.window;
    const topN = this.cfg.leaderboard.topN;
    const body = (await this.rest.getJson(
      `/v2/leaderboard/${window}?limit=${topN}`,
    )) as LeaderboardResponse;

    const rows = Array.isArray(body.traders) ? body.traders : [];
    const out: WatchedTrader[] = [];
    for (const row of rows.slice(0, topN)) {
      if (!row.userId) {
        log.warn(`Leaderboard row missing userId (handle=${row.handle}) — skipped`);
        continue;
      }
      out.push({
        userId: row.userId,
        handle: row.handle,
        enabled: true,
        rank: row.rank,
        chains: this.cfg.filters.allowedChains.filter(
          (c) => c === "solana" || c === "base" || this.cfg.filters.allowedChains.includes(c),
        ) as ChainName[],
        activeForEntries: true,
        source: "leaderboard",
      });
    }
    if (!out.length) {
      log.warn(`Leaderboard ${window} returned 0 traders with userId`);
    }
    return out;
  }
}

function matches(
  t: WatchedTrader,
  alertUserId: string | null,
  handle: string | null,
): boolean {
  if (alertUserId && t.userId === alertUserId) return true;
  if (t.handle && handle) {
    return t.handle.replace(/^@/, "").toLowerCase() === handle.replace(/^@/, "").toLowerCase();
  }
  return false;
}
