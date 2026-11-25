import path from "node:path";
import {
  ensureDataDir,
  loadAppConfig,
  loadEnv,
} from "./config.js";
import { CopyEngine } from "./engine/copy.js";
import { shouldPollRest } from "./engine/polling.js";
import { startPositionReconcileLoop } from "./engine/reconcilePositions.js";
import { startTpSlLoop } from "./engine/risk.js";
import { Watchlist } from "./engine/watchlist.js";
import { ExecutionRouter } from "./execution/index.js";
import { FomoRestClient } from "./fomo/client.js";
import { FomoAlertFanout } from "./fomo/ws.js";
import { TelegramNotifier } from "./notify/telegram.js";
import { PUBLIC_RPC_HOLDER_WARNING, isPublicSolanaRpc } from "./security/tokenSafety.js";
import { Store } from "./store/db.js";
import type { NormalizedAlert } from "./types.js";
import { KillSwitch } from "./utils/killswitch.js";
import { log, setLogLevel } from "./utils/logger.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadAppConfig(env.configPath, env);
  setLogLevel(cfg.logging.level);
  ensureDataDir(env.dataDir);

  const store = new Store(env.dataDir);
  const kill = new KillSwitch(env.killSwitchPath);
  const tg = new TelegramNotifier(
    env.telegramBotToken,
    env.telegramChatId,
    env.telegramAllowedUserIds,
  );
  const exec = new ExecutionRouter(env, cfg, undefined, store);

  let wsStatus = "starting";
  let fanout: FomoAlertFanout | null = null;

  const rest = env.fomoApiKey ? new FomoRestClient(env.fomoApiKey) : null;

  const openTraderKeys = (): string[] => {
    const keys: string[] = [];
    for (const row of store.tradersWithOpenPositions()) {
      if (row.userId) keys.push(row.userId);
      if (row.handle) keys.push(row.handle);
    }
    return keys;
  };

  const resubscribe = () => {
    if (!fanout) return;
    fanout.setTraders(watchlist.subscribeKeysWithOpen(openTraderKeys()));
  };

  const watchlist = new Watchlist(
    cfg,
    rest,
    async (change) => {
      await tg.notifyWatchlistChange({
        ...change,
        window: cfg.traderSource === "leaderboard" ? cfg.leaderboard.window : undefined,
        source: cfg.traderSource,
      });
      // Keep sockets for alumni who still have open bags
      resubscribe();
    },
    store,
  );

  const engine = new CopyEngine(env, cfg, store, exec, kill, tg, watchlist, rest);

  tg.attach({
    store,
    kill,
    cfg,
    dryRun: env.dryRun,
    getWsStatus: () => wsStatus,
    getWatchlistSummary: () =>
      watchlist
        .listActive()
        .map((t) => t.handle ?? t.userId)
        .join(", ") || "(none)",
    onCloseToken: (query) => engine.closeToken(query),
    onWriteoffToken: (query) => engine.writeOffToken(query),
  });
  tg.startCommandPolling();

  log.info(
    `FOMO CopyBot starting dryRun=${env.dryRun} source=${cfg.traderSource}` +
      (cfg.traderSource === "leaderboard"
        ? ` window=${cfg.leaderboard.window} topN=${cfg.leaderboard.topN}`
        : ""),
  );
  log.info(
    `Sizing: ${cfg.sizing.mode} $${cfg.sizing.fixedUsd} (max $${cfg.sizing.maxUsdPerTrade}, daily budget $${cfg.risk.dailyBudgetUsd})`,
  );
  log.info(
    `Enabled chains: solana=${cfg.chains.solana} base=${cfg.chains.base} allowedChains=[${cfg.filters.allowedChains.join(",")}]`,
  );
  if ((cfg.filters.maxTopHolderBps ?? 0) > 0 && isPublicSolanaRpc(env.solanaRpcUrl)) {
    log.warn(PUBLIC_RPC_HOLDER_WARNING);
    if (!env.dryRun) {
      log.error("Refusing live trading on the public Solana RPC while the top-holder check is on.");
      process.exit(1);
    }
  }

  if (!env.fomoApiKey) {
    log.warn("FOMO_API_KEY empty — leaderboard/WS/REST will fail until you set it (see README)");
  }
  if (env.dryRun) {
    log.info("DRY_RUN=true — quotes may be fetched; no transactions will be signed/sent");
  } else {
    log.warn("DRY_RUN=false — LIVE TRADING. Use a fresh wallet with small balance.");
    if (cfg.chains.solana && exec.solana && !exec.solana.ready()) {
      log.warn("Solana enabled but SOLANA_PRIVATE_KEY not ready");
    }
    if (cfg.chains.base && exec.base && !exec.base.ready()) {
      log.warn("Base enabled but BASE_PRIVATE_KEY / ZEROX_API_KEY not ready");
    }
  }

  // Resolve watchlist (leaderboard fetch or manual) before opening sockets
  try {
    await watchlist.start();
  } catch (e) {
    log.error("Failed to build watchlist", e);
    await tg.notifyBoot(
      `Failed to build watchlist: ${e instanceof Error ? e.message : String(e)}. Check FOMO_API_KEY / traderSource.`,
    );
    process.exit(1);
  }

  // Resolve signed-but-unconfirmed swaps before reopening 'closing' rows.
  try {
    const { reconcilePendingSwaps } = await import("./store/reconcilePending.js");
    await reconcilePendingSwaps({
      store,
      env,
      cfg,
      tg,
      rpcUrl: env.solanaRpcUrl,
    });
  } catch (e) {
    log.warn("Pending swap reconciliation failed", e);
  }

  const stuck = store.resetStuckClosing();
  if (stuck > 0) {
    log.warn(`Reset ${stuck} position(s) stuck in 'closing' back to open so exits can run`);
  }

  const traders = watchlist.subscribeKeysWithOpen(openTraderKeys());
  await tg.notifyBoot(
    `Started. dryRun=${env.dryRun} source=${cfg.traderSource}` +
      (cfg.traderSource === "leaderboard"
        ? ` (${cfg.leaderboard.window} top ${cfg.leaderboard.topN})`
        : "") +
      ` size=$${cfg.sizing.fixedUsd} paused=${kill.isPaused()} watching: ${traders.join(", ") || "(none)"}. Commands: /status /positions /stats /pause /resume /close /writeoff`,
  );
  // Initial watchlist announcement
  await tg.notifyWatchlistChange({
    added: watchlist.listActive(),
    removed: [],
    current: watchlist.listActive(),
    window: cfg.traderSource === "leaderboard" ? cfg.leaderboard.window : undefined,
    source: cfg.traderSource,
  });

  const onAlert = async (alert: Parameters<CopyEngine["handleAlert"]>[0]) => {
    await engine.handleAlert(alert);
  };

  if (env.fomoApiKey) {
    fanout = new FomoAlertFanout({
      apiKey: env.fomoApiKey,
      traders,
      onAlert,
      onStatus: (s) => {
        wsStatus = s;
      },
    });
    fanout.start();
    wsStatus = "connecting";
  } else {
    wsStatus = "no_api_key";
  }

  let restTimer: NodeJS.Timeout | null = null;
  if (rest && cfg.poll.alertsRestEnabled) {
    restTimer = setInterval(() => {
      void (async () => {
        try {
          if (
            !shouldPollRest({
              enabled: cfg.poll.alertsRestEnabled,
              onlyWhenWsDown: cfg.poll.alertsRestOnlyWhenWsDown,
              wsHealthy: fanout?.isHealthy() ?? false,
            })
          ) {
            return;
          }
          const since = store.getMeta("alerts_since") ?? undefined;
          const active = watchlist.listActive();
          const alerts = await rest.alerts({ since, limit: 50, type: "buy" });
          const sells = await rest.alerts({ since, limit: 50, type: "sell" });
          const batch: NormalizedAlert[] = [];
          let maxTs: number | null = null;
          for (const a of [...alerts, ...sells]) {
            const watched =
              watchlist.findActive(a.userId, a.traderHandle) ||
              (a.alertType === "sell"
                ? watchlist.findForClose(a.userId, a.traderHandle)
                : null);
            if (!watched && a.alertType === "buy") continue;
            // For sells from alumni with positions, still handle
            if (a.alertType === "sell" && !watched) {
              const key = a.userId ?? a.traderHandle ?? "";
              if (
                !key ||
                !store.findOpenByTraderToken(key, a.tokenAddress ?? "", a.chain, {
                  includeDryRun: env.dryRun,
                })
              ) {
                continue;
              }
            }
            batch.push(a);
            if (a.ts != null && (maxTs == null || a.ts > maxTs)) maxTs = a.ts;
          }
          void active;
          if (batch.length) await engine.handleAlerts(batch);
          if (maxTs != null) {
            store.setMeta("alerts_since", new Date(maxTs).toISOString());
          }
        } catch (e) {
          log.warn(
            `REST alerts poll failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
    }, cfg.poll.alertsRestIntervalSec * 1000);
    log.info(
      `REST alerts every ${cfg.poll.alertsRestIntervalSec}s` +
        (cfg.poll.alertsRestOnlyWhenWsDown ? " (only while WebSocket is down)" : " (even while WebSocket is up)"),
    );
  }

  const tpSlTimer = startTpSlLoop({
    cfg,
    store,
    exec,
    dryRun: env.dryRun,
    tg,
    onTrigger: async (pos, reason, _mark, fraction) => {
      await engine.closePosition(pos, reason, undefined, { fraction });
    },
  });

  const retryTimer = setInterval(() => {
    void engine.drainSellRetries().catch((e) => {
      log.warn(`sell retry drain failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, 5_000);
  const pendingTimer = setInterval(() => {
    void import("./store/reconcilePending.js")
      .then(({ reconcilePendingSwaps }) =>
        reconcilePendingSwaps({ store, env, cfg, tg, rpcUrl: env.solanaRpcUrl }),
      )
      .catch((e) => {
        log.warn(`pending recheck failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, 30_000);

  const reconcile = startPositionReconcileLoop({
    cfg,
    store,
    fomo: rest,
    includeDryRun: env.dryRun,
    onFlat: async (pos) => {
      await engine.closePosition(pos, "reconcile_flat");
    },
  });

  const shutdown = () => {
    log.info("Shutting down…");
    watchlist.stop();
    fanout?.stop();
    tg.stop();
    if (restTimer) clearInterval(restTimer);
    clearInterval(tpSlTimer);
    clearInterval(retryTimer);
    clearInterval(pendingTimer);
    reconcile?.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => {
    log.error(
      `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  });
  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    process.exit(1);
  });

  log.info(`Config: ${path.resolve(env.configPath)}`);
  log.info("Running. Ctrl+C to stop. Telegram: /status /pause /resume");
}

main().catch((e) => {
  log.error("Fatal", e);
  process.exit(1);
});
