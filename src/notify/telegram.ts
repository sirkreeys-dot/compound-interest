/**
 * First-class Telegram notifications + bot commands.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Commands (restricted to TELEGRAM_CHAT_ID): /status /positions /pause /resume /help
 */
import { log } from "../utils/logger.js";
import type { KillSwitch } from "../utils/killswitch.js";
import type { Store } from "../store/db.js";
import type { AppConfig, NormalizedAlert, OpenPosition, SkipReason } from "../types.js";

const API = "https://api.telegram.org";

export interface TelegramDeps {
  token: string;
  chatId: string;
  store: Store;
  kill: KillSwitch;
  cfg: AppConfig;
  dryRun: boolean;
  getWsStatus: () => string;
  getWatchlistSummary?: () => string;
}

export class TelegramNotifier {
  private readonly token: string;
  private readonly chatId: string;
  /** When non-empty, commands require message.from.id in this set (in addition to chat id). */
  private readonly allowedUserIds: Set<string>;
  private offset = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private deps: Omit<TelegramDeps, "token" | "chatId"> | null = null;
  readonly enabled: boolean;

  constructor(token: string, chatId: string, allowedUserIds: string[] = []) {
    this.token = token;
    this.chatId = chatId;
    this.allowedUserIds = new Set(allowedUserIds.map((s) => String(s).trim()).filter(Boolean));
    this.enabled = Boolean(token && chatId);
    if (!this.enabled) {
      log.warn(
        "Telegram disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for notifications and commands",
      );
    }
  }

  /** Wire store/kill/config so slash commands work. */
  attach(deps: Omit<TelegramDeps, "token" | "chatId">): void {
    this.deps = deps;
  }

  startCommandPolling(): void {
    if (!this.enabled) return;
    const tick = async () => {
      try {
        await this.pollUpdates();
      } catch (e) {
        log.debug("Telegram poll error", e);
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), 2500);
    log.info("Telegram command polling started (/status /positions /pause /resume)");
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async send(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<void> {
    if (!this.enabled) {
      log.debug(`Telegram skip (disabled): ${text.slice(0, 80)}`);
      return;
    }
    try {
      const res = await fetch(`${API}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        log.warn(`Telegram sendMessage failed ${res.status}: ${body.slice(0, 200).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")}`);
      }
    } catch (e) {
      log.warn("Telegram send error", e);
    }
  }

  async notifyEntry(opts: {
    alert: NormalizedAlert;
    sizeUsd: number;
    dryRun: boolean;
    txHash?: string;
    quoteSummary?: string;
  }): Promise<void> {
    const { alert, sizeUsd, dryRun, txHash, quoteSummary } = opts;
    const mode = dryRun ? "DRY-RUN" : "LIVE";
    await this.send(
      [
        `<b>🟢 ENTRY ${mode}</b>`,
        `Trader: <code>${esc(alert.traderHandle ?? alert.userId ?? "?")}</code>`,
        `Side: BUY`,
        `Token: ${esc(alert.tokenSymbol ?? "?")} (<code>${esc(alert.tokenAddress ?? "")}</code>)`,
        `Chain: ${esc(alert.chain)}`,
        `Size: $${sizeUsd.toFixed(2)}`,
        alert.tradeUsd != null ? `Trader fill: $${alert.tradeUsd.toFixed(2)}` : `Trader fill: <i>unknown (no tradeUsd)</i>`,
        txHash ? `Tx: <code>${esc(txHash)}</code>` : "",
        quoteSummary ? `Quote: ${esc(quoteSummary)}` : "",
        `Event: <code>${esc(alert.eventId)}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifyExit(opts: {
    pos: OpenPosition;
    reason: string;
    exitUsd: number;
    pnlUsd: number;
    dryRun: boolean;
    txHash?: string;
  }): Promise<void> {
    const { pos, reason, exitUsd, pnlUsd, dryRun, txHash } = opts;
    const mode = dryRun ? "DRY-RUN" : "LIVE";
    const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
    await this.send(
      [
        `<b>${emoji} EXIT ${mode}</b>`,
        `Reason: ${esc(reason)}`,
        `Token: ${esc(pos.tokenSymbol ?? "?")} (<code>${esc(pos.tokenAddress)}</code>)`,
        `Chain: ${esc(pos.chain)}`,
        `Trader: <code>${esc(pos.traderHandle ?? pos.traderUserId ?? "?")}</code>`,
        `Entry size: $${pos.sizeUsd.toFixed(2)} → Exit: $${exitUsd.toFixed(2)}`,
        `<b>PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}</b>`,
        txHash ? `Tx: <code>${esc(txHash)}</code>` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifySkip(alert: NormalizedAlert, reason: SkipReason, detail?: string): Promise<void> {
    // Keep skips quieter but still notify (user asked for every skipped trade with reason)
    await this.send(
      [
        `<b>⏭ SKIPPED</b>`,
        `Reason: <code>${esc(reason)}</code>${detail ? ` — ${esc(detail)}` : ""}`,
        `Trader: <code>${esc(alert.traderHandle ?? alert.userId ?? "?")}</code>`,
        `Side: ${esc(alert.alertType)}`,
        `Token: ${esc(alert.tokenSymbol ?? "?")} on ${esc(alert.chain)}`,
        alert.tradeUsd != null ? `Trader fill: $${alert.tradeUsd.toFixed(2)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifyPnl(summary: string): Promise<void> {
    await this.send(`<b>📈 PnL</b>\n${esc(summary)}`);
  }

  async notifyBoot(msg: string): Promise<void> {
    await this.send(`<b>🤖 FOMO CopyBot</b>\n${esc(msg)}`);
  }

  async notifyWatchlistChange(change: {
    added: Array<{ handle?: string; userId: string; rank?: number }>;
    removed: Array<{ handle?: string; userId: string; rank?: number }>;
    current: Array<{ handle?: string; userId: string; rank?: number }>;
    window?: string;
    source: string;
  }): Promise<void> {
    const fmt = (t: { handle?: string; userId: string; rank?: number }) =>
      `#${t.rank ?? "?"} ${esc(t.handle ?? "?")} (<code>${esc(t.userId.slice(0, 8))}…</code>)`;
    const lines = [
      `<b>👥 Watchlist updated</b> (${esc(change.source)}${change.window ? ` / ${esc(change.window)}` : ""})`,
    ];
    if (change.added.length) {
      lines.push(`<b>Added</b>:`);
      for (const t of change.added) lines.push(`  + ${fmt(t)}`);
    }
    if (change.removed.length) {
      lines.push(`<b>Removed</b> (no new entries; open positions can still close):`);
      for (const t of change.removed) lines.push(`  − ${fmt(t)}`);
    }
    lines.push(`<b>Now following (${change.current.length})</b>:`);
    for (const t of change.current) lines.push(`  • ${fmt(t)}`);
    await this.send(lines.join("\n"));
  }

  async notifySellSizing(opts: {
    method: string;
    fraction: number;
    detail: string;
  }): Promise<void> {
    await this.send(
      [
        `<b>Sell sizing</b>`,
        `Method: <code>${esc(opts.method)}</code>`,
        `Fraction: ${(opts.fraction * 100).toFixed(1)}%`,
        esc(opts.detail),
      ].join("\n"),
    );
  }

  /** @internal */ async pollUpdatesForTests(): Promise<void> { return this.pollUpdates(); }

  private async pollUpdates(): Promise<void> {
    // Token is required by Telegram HTTP API path design; never log this URL.
    const url = `${API}/bot${this.token}/getUpdates?timeout=0&offset=${this.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "edited_message"]))}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          chat?: { id?: number | string };
          from?: { id?: number | string };
          text?: string;
        };
        edited_message?: {
          chat?: { id?: number | string };
          from?: { id?: number | string };
          text?: string;
        };
      }>;
    };
    if (!data.ok || !data.result) return;
    const expected = String(this.chatId).trim();
    for (const u of data.result) {
      this.offset = u.update_id + 1;
      const msg = u.message ?? u.edited_message;
      const chatId = msg?.chat?.id;
      const fromId = msg?.from?.id;
      const text = msg?.text?.trim() ?? "";
      if (!text.startsWith("/")) continue;
      // Missing chat id → ignore (do not treat as authorized)
      if (chatId === undefined || chatId === null) {
        log.warn("Ignored Telegram command with missing chat id");
        continue;
      }
      // Restrict to configured chat id (string compare so number/string env both work)
      if (String(chatId).trim() !== expected) {
        log.warn(`Ignored Telegram command from unauthorized chat`);
        continue;
      }
      // Optional sender lock (group-safe): when TELEGRAM_ALLOWED_USER_IDS is set
      if (this.allowedUserIds.size > 0) {
        if (fromId === undefined || fromId === null) {
          log.warn("Ignored Telegram command with missing from.id (allowed-user lock)");
          continue;
        }
        if (!this.allowedUserIds.has(String(fromId).trim())) {
          log.warn(`Ignored Telegram command from unauthorized user id`);
          continue;
        }
      }
      await this.handleCommand(text.split(/\s+/)[0]!.split("@")[0]!);
    }
  }

  private async handleCommand(cmd: string): Promise<void> {
    const d = this.deps;
    if (!d) {
      await this.send("Bot internals not attached yet.");
      return;
    }
    switch (cmd) {
      case "/help":
        await this.send(
          [
            "<b>Commands</b> (this chat only)",
            "/status — mode, pause, positions, daily spend, WS",
            "/positions — open positions",
            "/pause — kill switch ON (block new entries)",
            "/resume — kill switch OFF",
            "/help — this message",
          ].join("\n"),
        );
        break;
      case "/status": {
        const daily = d.store.getDaily();
        const open = d.store.listOpen();
        const watching =
          d.getWatchlistSummary?.() ??
          d.cfg.traders.filter((t) => t.enabled).map((t) => t.handle ?? t.userId).join(", ");
        await this.send(
          [
            `<b>Status</b>`,
            `Mode: ${d.dryRun ? "DRY_RUN" : "LIVE"}`,
            `Source: ${esc(d.cfg.traderSource)}${d.cfg.traderSource === "leaderboard" ? ` (${d.cfg.leaderboard.window} top ${d.cfg.leaderboard.topN})` : ""}`,
            `Paused: ${d.kill.isPaused() ? "YES" : "no"}`,
            `WS: ${esc(d.getWsStatus())}`,
            `Size: $${d.cfg.sizing.fixedUsd} fixed (max $${d.cfg.sizing.maxUsdPerTrade})`,
            `Open positions: ${open.length} / ${d.cfg.risk.maxOpenPositions}`,
            `Today spent: $${daily.spentUsd.toFixed(2)} / $${d.cfg.risk.dailyBudgetUsd}`,
            `Today realized PnL: $${daily.realizedPnlUsd.toFixed(2)}`,
            `Today trades: ${daily.trades}`,
            `Watching: ${esc(watching)}`,
          ].join("\n"),
        );
        break;
      }
      case "/positions": {
        const open = d.store.listOpen();
        if (!open.length) {
          await this.send("No open positions.");
          break;
        }
        const lines = open.map(
          (p, i) =>
            `${i + 1}. ${esc(p.tokenSymbol ?? "?")} ${esc(p.chain)} $${p.sizeUsd.toFixed(2)} from <code>${esc(p.traderHandle ?? "?")}</code> @ ${esc(p.openedAt)}`,
        );
        await this.send(`<b>Open positions (${open.length})</b>\n${lines.join("\n")}`);
        break;
      }
      case "/pause":
        d.kill.pause("telegram:/pause");
        await this.send("⏸ Kill switch ON — new entries blocked. Exits still allowed.");
        break;
      case "/resume":
        d.kill.resume();
        await this.send("▶️ Kill switch OFF — entries allowed again.");
        break;
      default:
        await this.send(`Unknown command ${esc(cmd)}. Try /help`);
    }
  }
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @internal exported for tests */
export { esc as escapeHtml };
