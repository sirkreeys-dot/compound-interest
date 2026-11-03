import WebSocket from "ws";
import { log } from "../utils/logger.js";
import { parseAlert, parseWelcome } from "./adapter.js";
import type { NormalizedAlert } from "../types.js";

export type AlertHandler = (alert: NormalizedAlert) => void | Promise<void>;

export interface FomoWsOptions {
  apiKey: string;
  traders: string[];
  onAlert: AlertHandler;
  onStatus?: (msg: string) => void;
}

export class FomoAlertSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly opts: FomoWsOptions;
  private readonly trader: string;

  constructor(opts: FomoWsOptions & { trader: string }) {
    this.opts = opts;
    this.trader = opts.trader;
  }

  get traderKey(): string {
    return this.trader;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    // Tear down any prior socket before opening another (anti reconnect-storm)
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.removeAllListeners();
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    const params = new URLSearchParams({ key: this.opts.apiKey });
    if (this.trader) params.set("trader", this.trader);
    // Never log the API key
    log.info(`Connecting FOMO /ws/alerts trader=${this.trader || "(all)"}…`);
    const ws = new WebSocket(`wss://api.fomoapi.io/ws/alerts?${params.toString()}`);
    this.ws = ws;

    ws.on("open", () => {
      if (this.stopped) {
        ws.close();
        return;
      }
      this.attempt = 0;
      log.info(`FOMO WebSocket open for ${this.trader || "all"}`);
      this.opts.onStatus?.("ws_open");
    });

    ws.on("message", (data) => {
      void this.onMessage(data.toString());
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return; // stale
      this.ws = null;
      log.warn(`FOMO WS closed trader=${this.trader} code=${code} reason=${reason.toString()}`);
      this.opts.onStatus?.(`ws_close:${code}`);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      // Avoid dumping objects that might contain headers/urls with keys
      log.error(`FOMO WS error trader=${this.trader}: ${err instanceof Error ? err.message : "error"}`);
    });
  }

  private async onMessage(text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      log.debug("Non-JSON WS frame", text.slice(0, 120));
      return;
    }
    const welcome = parseWelcome(msg);
    if (welcome) {
      log.info(
        `FOMO welcome trader=${this.trader} realtime=${welcome.realtime ?? "?"} delaySeconds=${welcome.delaySeconds ?? "?"}`,
      );
      return;
    }
    if (msg && typeof msg === "object" && (msg as { type?: string }).type === "subscribed") {
      log.info("FOMO subscribed", msg);
      return;
    }
    const alert = parseAlert(msg);
    if (!alert) return;
    if (alert.alertType !== "buy" && alert.alertType !== "sell") {
      log.debug(`Ignoring non-trade alertType=${alert.alertType}`);
      return;
    }
    try {
      await this.opts.onAlert(alert);
    } catch (e) {
      log.error("onAlert handler failed", e);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.attempt += 1;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 5));
    log.info(`Reconnecting FOMO WS trader=${this.trader} in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export class FomoAlertFanout {
  private sockets = new Map<string, FomoAlertSocket>();
  private readonly apiKey: string;
  private readonly onAlert: AlertHandler;
  private readonly onStatus?: (msg: string) => void;
  private started = false;

  constructor(opts: FomoWsOptions) {
    this.apiKey = opts.apiKey;
    this.onAlert = opts.onAlert;
    this.onStatus = opts.onStatus;
    if (opts.traders.length) this.setTraders(opts.traders);
  }

  start(): void {
    this.started = true;
    for (const s of this.sockets.values()) s.start();
  }

  stop(): void {
    this.started = false;
    for (const s of this.sockets.values()) s.stop();
    this.sockets.clear();
  }

  setTraders(traders: string[]): void {
    const next = new Set(traders.filter(Boolean));
    for (const [key, sock] of this.sockets) {
      if (!next.has(key)) {
        log.info(`WS unsubscribe trader=${key}`);
        sock.stop();
        this.sockets.delete(key);
      }
    }
    for (const t of next) {
      if (this.sockets.has(t)) continue;
      const sock = new FomoAlertSocket({
        apiKey: this.apiKey,
        traders: [t],
        trader: t,
        onAlert: this.onAlert,
        onStatus: this.onStatus,
      });
      this.sockets.set(t, sock);
      if (this.started) sock.start();
    }
  }

  currentTraders(): string[] {
    return [...this.sockets.keys()];
  }
}
