import type { AppConfig, NormalizedAlert, SkipReason, TraderConfig } from "../types.js";
import { isValidTokenAddress } from "../security/addresses.js";
import type { Store } from "../store/db.js";
import type { Watchlist, WatchedTrader } from "./watchlist.js";

export interface FilterContext {
  cfg: AppConfig;
  store: Store;
  dryRun: boolean;
  /** Kill switch — blocks NEW ENTRIES only, not sells. */
  paused: boolean;
  watchlist: Watchlist;
}

export interface FilterResult {
  ok: boolean;
  reason?: SkipReason;
  detail?: string;
  trader?: TraderConfig;
  watched?: WatchedTrader;
  sizeUsd?: number;
}

export function evaluateAlert(alert: NormalizedAlert, ctx: FilterContext): FilterResult {
  if (ctx.store.hasEvent(alert.eventId)) {
    return { ok: false, reason: "already_processed", detail: alert.eventId };
  }

  if (!alert.tokenAddress) {
    return { ok: false, reason: "no_token_address", detail: alert.tokenSymbol ?? "?" };
  }
  if (!isValidTokenAddress(alert.chain, alert.tokenAddress)) {
    return {
      ok: false,
      reason: "invalid_token_address",
      detail: `${alert.chain}:${alert.tokenAddress.slice(0, 20)}`,
    };
  }
  // Reject non-finite / negative sizing inputs early when present
  if (alert.tradeUsd != null && !(alert.tradeUsd >= 0) ) {
    return { ok: false, reason: "other", detail: "tradeUsd not a finite non-negative number" };
  }
  if (alert.marketCapUsd != null && !(alert.marketCapUsd >= 0)) {
    return { ok: false, reason: "market_cap", detail: "marketCapUsd invalid" };
  }

  // Chain enablement first — never trade or price a disabled chain
  if (alert.chain === "solana" && !ctx.cfg.chains.solana) {
    return {
      ok: false,
      reason: "unsupported_chain",
      detail: "solana disabled (chains.solana=false / not in ENABLED_CHAINS)",
    };
  }
  if (alert.chain === "base" && !ctx.cfg.chains.base) {
    return {
      ok: false,
      reason: "unsupported_chain",
      detail: "base disabled (chains.base=false / not in ENABLED_CHAINS)",
    };
  }
  if (alert.chain !== "solana" && alert.chain !== "base") {
    return {
      ok: false,
      reason: "unsupported_chain",
      detail: `${alert.chain} has no executor in this bot`,
    };
  }

  const allowed = ctx.cfg.filters.allowedChains;
  if (!allowed.includes(alert.chain)) {
    return {
      ok: false,
      reason: "unsupported_chain",
      detail: `${alert.chain} not in filters.allowedChains`,
    };
  }

  if (alert.alertType === "buy") {
    // Kill switch blocks entries only
    if (ctx.paused) {
      return { ok: false, reason: "paused", detail: "Kill switch /pause active" };
    }

    const watched = ctx.watchlist.findActive(alert.userId, alert.traderHandle);
    if (!watched) {
      const alumni = ctx.watchlist.findForClose(alert.userId, alert.traderHandle);
      if (alumni && !alumni.activeForEntries) {
        return {
          ok: false,
          reason: "trader_inactive_alumni",
          detail: "dropped from watchlist — no new entries; sells still allowed",
        };
      }
      return {
        ok: false,
        reason: "trader_not_watched",
        detail: alert.traderHandle ?? alert.userId ?? "?",
      };
    }

    if (watched.chains.length && !watched.chains.includes(alert.chain)) {
      return {
        ok: false,
        reason: "chain_disabled_for_trader",
        detail: `${alert.chain} not in trader.chains`,
      };
    }

    const mc = alert.marketCapUsd;
    if (mc != null) {
      if (ctx.cfg.filters.marketCapMinUsd > 0 && mc < ctx.cfg.filters.marketCapMinUsd) {
        return { ok: false, reason: "market_cap", detail: `mcap ${mc} < min` };
      }
      if (ctx.cfg.filters.marketCapMaxUsd > 0 && mc > ctx.cfg.filters.marketCapMaxUsd) {
        return { ok: false, reason: "market_cap", detail: `mcap ${mc} > max` };
      }
    }

    const minT = ctx.cfg.sizing.minTraderTradeUsd;
    if (minT > 0 && alert.tradeUsd != null && alert.tradeUsd < minT) {
      return {
        ok: false,
        reason: "below_min_trader_size",
        detail: `tradeUsd=${alert.tradeUsd} < ${minT}`,
      };
    }

    // Dry-run positions don't count against live firstBuysOnly / max positions /
    // daily budget — use includeDryRun only when we ourselves are in dry-run.
    const liveOnly = !ctx.dryRun;
    if (ctx.cfg.filters.firstBuysOnly) {
      if (ctx.store.hasOpenToken(alert.tokenAddress, alert.chain, liveOnly)) {
        return { ok: false, reason: "first_buys_only", detail: "already have open position on token" };
      }
    }

    const openCount = liveOnly
      ? ctx.store.countOpenLive()
      : ctx.store.listOpen({ includeDryRun: true }).length;
    if (openCount >= ctx.cfg.risk.maxOpenPositions) {
      return {
        ok: false,
        reason: "max_positions",
        detail: `${openCount}/${ctx.cfg.risk.maxOpenPositions}`,
      };
    }

    const last = ctx.store.lastEntryAt();
    if (last && ctx.cfg.risk.cooldownSeconds > 0) {
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < ctx.cfg.risk.cooldownSeconds) {
        return {
          ok: false,
          reason: "cooldown",
          detail: `${Math.ceil(ctx.cfg.risk.cooldownSeconds - elapsed)}s left`,
        };
      }
    }

    const sizeUsd = computeSizeUsd(alert, ctx.cfg);
    if (sizeUsd == null) {
      return {
        ok: false,
        reason: "sizing_unknown",
        detail: "percent_of_trader needs tradeUsd on alert",
      };
    }
    if (sizeUsd > ctx.cfg.sizing.maxUsdPerTrade) {
      return {
        ok: false,
        reason: "above_max_trade",
        detail: `${sizeUsd} > max ${ctx.cfg.sizing.maxUsdPerTrade}`,
      };
    }

    // Daily budget from persisted SQLite — survives restarts. Dry-run does not
    // inflate live spent_usd (copy engine only addSpend when !dryRun).
    if (!ctx.dryRun) {
      const daily = ctx.store.getDaily();
      if (daily.spentUsd + sizeUsd > ctx.cfg.risk.dailyBudgetUsd) {
        return {
          ok: false,
          reason: "daily_budget",
          detail: `spent ${daily.spentUsd} + ${sizeUsd} > ${ctx.cfg.risk.dailyBudgetUsd}`,
        };
      }
    }

    return { ok: true, trader: watched, watched, sizeUsd };
  }

  if (alert.alertType === "sell") {
    // Sells are allowed even when kill switch is on
    if (!ctx.cfg.risk.copySells) {
      return { ok: false, reason: "other", detail: "copySells disabled" };
    }
    const watched = ctx.watchlist.findForClose(alert.userId, alert.traderHandle);
    const includeDry = ctx.dryRun;
    const key =
      watched?.userId ?? watched?.handle ?? alert.userId ?? alert.traderHandle ?? "";
    const pos = key
      ? ctx.store.findOpenByTraderToken(key, alert.tokenAddress, alert.chain, {
          includeDryRun: includeDry,
        })
      : null;
    const pos2 =
      !pos && alert.traderHandle
        ? ctx.store.findOpenByTraderToken(
            alert.traderHandle,
            alert.tokenAddress,
            alert.chain,
            { includeDryRun: includeDry },
          )
        : null;
    const found = pos ?? pos2;
    if (!found) {
      if (!watched) {
        return {
          ok: false,
          reason: "trader_not_watched",
          detail: alert.traderHandle ?? alert.userId ?? "?",
        };
      }
      return {
        ok: false,
        reason: "sell_without_our_position",
        detail: "only the trader who opened (and we copied) can close",
      };
    }
    return {
      ok: true,
      trader: watched ?? undefined,
      watched: watched ?? undefined,
      sizeUsd: found.remainingUsd,
    };
  }

  return { ok: false, reason: "other", detail: `alertType=${alert.alertType}` };
}

export function computeSizeUsd(alert: NormalizedAlert, cfg: AppConfig): number | null {
  if (cfg.sizing.mode === "fixed_usd") {
    return Math.min(cfg.sizing.fixedUsd, cfg.sizing.maxUsdPerTrade);
  }
  if (alert.tradeUsd == null || alert.tradeUsd <= 0) return null;
  const raw = (alert.tradeUsd * cfg.sizing.percentOfTrader) / 100;
  return Math.min(raw, cfg.sizing.maxUsdPerTrade);
}
