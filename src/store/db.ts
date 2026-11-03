import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DailyStats, OpenPosition } from "../types.js";

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "copybot.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        trader_user_id TEXT,
        trader_handle TEXT,
        trade_id TEXT,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        entry_usd REAL NOT NULL,
        size_usd REAL NOT NULL,
        remaining_usd REAL NOT NULL DEFAULT 0,
        quantity_raw TEXT,
        entry_price_usd REAL,
        trader_size_at_entry_usd REAL,
        opened_at TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        is_dry_run INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT,
        exit_usd REAL,
        exit_reason TEXT,
        realized_pnl_usd REAL,
        tx_entry TEXT,
        tx_exit TEXT
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        spent_usd REAL NOT NULL DEFAULT 0,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        trades INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alumni (
        user_id TEXT PRIMARY KEY,
        handle TEXT,
        chains_json TEXT NOT NULL,
        source TEXT NOT NULL,
        rank INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_swaps (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        chain TEXT NOT NULL,
        side TEXT NOT NULL,
        source_event_id TEXT,
        trader_user_id TEXT,
        trader_handle TEXT,
        token_address TEXT,
        token_symbol TEXT,
        size_usd REAL,
        sell_token TEXT,
        buy_token TEXT,
        in_amount_raw TEXT,
        expected_out_raw TEXT,
        tx_signature TEXT,
        position_id TEXT,
        error TEXT,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_swaps(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_source_event
        ON positions(source_event_id);
    `);
    this.migrate();
  }

  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const add = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE positions ADD COLUMN ${ddl}`);
    };
    add("remaining_usd", "remaining_usd REAL NOT NULL DEFAULT 0");
    add("trader_size_at_entry_usd", "trader_size_at_entry_usd REAL");
    add("is_dry_run", "is_dry_run INTEGER NOT NULL DEFAULT 0");
    add("trader_token_amount_at_entry", "trader_token_amount_at_entry REAL");
    // Backfill remaining_usd for old rows
    this.db.exec(
      `UPDATE positions SET remaining_usd = size_usd WHERE remaining_usd = 0 AND status IN ('open','dry_open','closing')`,
    );
  }

  close(): void {
    this.db.close();
  }

  hasEvent(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM processed_events WHERE event_id = ?")
      .get(eventId) as { ok: number } | undefined;
    return Boolean(row);
  }

  /**
   * Atomically claim an event id. Returns true if THIS caller owns it
   * (first insert). Prevents double-processing on WS replay / races.
   */
  claimEvent(eventId: string): boolean {
    const before = this.hasEvent(eventId);
    if (before) return false;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)",
      )
      .run(eventId, new Date().toISOString());
    // If concurrent, only one insert succeeds; re-check we are the owner by
    // verifying row exists and we weren't before — INSERT OR IGNORE is atomic.
    // changes: node:sqlite StatementSync has .run returning { changes }
    return this.hasEvent(eventId) && !before;
  }

  /** Prefer run().changes when available. */
  claimEventStrict(eventId: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)",
      )
      .run(eventId, new Date().toISOString()) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  markEvent(eventId: string): void {
    this.claimEventStrict(eventId);
  }

  insertPosition(p: OpenPosition): void {
    this.db
      .prepare(
        `INSERT INTO positions (
          id, trader_user_id, trader_handle, trade_id, chain, token_address, token_symbol,
          entry_usd, size_usd, remaining_usd, quantity_raw, entry_price_usd, trader_size_at_entry_usd,
          trader_token_amount_at_entry, opened_at, source_event_id, status, is_dry_run, closed_at, exit_usd, exit_reason,
          realized_pnl_usd, tx_entry, tx_exit
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.traderUserId,
        p.traderHandle,
        p.tradeId,
        p.chain,
        p.tokenAddress,
        p.tokenSymbol,
        p.entryUsd,
        p.sizeUsd,
        p.remainingUsd,
        p.quantityRaw,
        p.entryPriceUsd,
        p.traderSizeAtEntryUsd,
        p.traderTokenAmountAtEntry,
        p.openedAt,
        p.sourceEventId,
        p.status,
        p.isDryRun ? 1 : 0,
        p.closedAt ?? null,
        p.exitUsd ?? null,
        p.exitReason ?? null,
        p.realizedPnlUsd ?? null,
        p.txEntry ?? null,
        p.txExit ?? null,
      );
  }

  /** Live open positions only (excludes dry-run). */
  listOpen(opts: { includeDryRun?: boolean } = {}): OpenPosition[] {
    const sql = opts.includeDryRun
      ? `SELECT * FROM positions WHERE status IN ('open','dry_open') ORDER BY opened_at DESC`
      : `SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`;
    const rows = this.db.prepare(sql).all() as Record<string, unknown>[];
    return rows.map(rowToPosition);
  }

  countOpenLive(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'open'`)
      .get() as { c: number };
    return Number(row.c);
  }

  findOpenByTraderToken(
    traderKey: string,
    tokenAddress: string,
    chain: string,
    opts: { includeDryRun?: boolean } = {},
  ): OpenPosition | null {
    const statuses = opts.includeDryRun ? "('open','dry_open')" : "('open')";
    const row = this.db
      .prepare(
        `SELECT * FROM positions WHERE status IN ${statuses} AND chain = ? AND lower(token_address) = lower(?)
         AND (trader_user_id = ? OR lower(coalesce(trader_handle,'')) = lower(?)) LIMIT 1`,
      )
      .get(chain, tokenAddress, traderKey, traderKey) as Record<string, unknown> | undefined;
    return row ? rowToPosition(row) : null;
  }

  hasOpenToken(tokenAddress: string, chain: string, liveOnly = true): boolean {
    const statusClause = liveOnly
      ? `status = 'open'`
      : `status IN ('open','dry_open')`;
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM positions WHERE ${statusClause} AND chain = ? AND lower(token_address) = lower(?)`,
      )
      .get(chain, tokenAddress) as { ok: number } | undefined;
    return Boolean(row);
  }

  /** Traders (userId/handle) that still have open live positions — keep WS subscribed. */
  tradersWithOpenPositions(): Array<{ userId: string | null; handle: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT trader_user_id AS userId, trader_handle AS handle
         FROM positions WHERE status IN ('open','closing')`,
      )
      .all() as Array<{ userId: string | null; handle: string | null }>;
    return rows;
  }

  /**
   * Lock position for close/partial. Returns position if successfully moved to 'closing'.
   */
  claimPositionForClose(id: string): OpenPosition | null {
    const result = this.db
      .prepare(
        `UPDATE positions SET status = 'closing'
         WHERE id = ? AND status IN ('open','dry_open')`,
      )
      .run(id) as { changes?: number };
    if (!(result.changes && result.changes > 0)) return null;
    const row = this.db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToPosition(row) : null;
  }

  /** Release lock back to open if sell failed. */
  revertClosingToOpen(id: string): void {
    this.db
      .prepare(
        `UPDATE positions SET status = CASE WHEN is_dry_run = 1 THEN 'dry_open' ELSE 'open' END
         WHERE id = ? AND status = 'closing'`,
      )
      .run(id);
  }

  applyPartialClose(
    id: string,
    opts: {
      soldRaw: string;
      remainingRaw: string;
      remainingUsd: number;
      realizedPnlUsd: number;
      txExit?: string;
      fullyClosed: boolean;
      isDryRun: boolean;
      exitReason: string;
      exitUsd: number;
    },
  ): void {
    if (opts.fullyClosed) {
      this.db
        .prepare(
          `UPDATE positions SET status=?, closed_at=?, exit_usd=?, exit_reason=?, realized_pnl_usd=?,
           tx_exit=?, quantity_raw=?, remaining_usd=0 WHERE id=?`,
        )
        .run(
          opts.isDryRun ? "dry_closed" : "closed",
          new Date().toISOString(),
          opts.exitUsd,
          opts.exitReason,
          opts.realizedPnlUsd,
          opts.txExit ?? null,
          "0",
          id,
        );
    } else {
      this.db
        .prepare(
          `UPDATE positions SET status = CASE WHEN is_dry_run = 1 THEN 'dry_open' ELSE 'open' END,
           quantity_raw=?, remaining_usd=?, realized_pnl_usd = coalesce(realized_pnl_usd,0) + ?,
           tx_exit=? WHERE id=?`,
        )
        .run(
          opts.remainingRaw,
          opts.remainingUsd,
          opts.realizedPnlUsd,
          opts.txExit ?? null,
          id,
        );
    }
  }

  closePosition(
    id: string,
    exit: { exitUsd: number; exitReason: string; realizedPnlUsd: number; txExit?: string; isDryRun?: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE positions SET status=?, closed_at=?, exit_usd=?, exit_reason=?, realized_pnl_usd=?, tx_exit=?, remaining_usd=0
         WHERE id=?`,
      )
      .run(
        exit.isDryRun ? "dry_closed" : "closed",
        new Date().toISOString(),
        exit.exitUsd,
        exit.exitReason,
        exit.realizedPnlUsd,
        exit.txExit ?? null,
        id,
      );
  }

  getDaily(date = todayUtc()): DailyStats {
    const row = this.db
      .prepare("SELECT * FROM daily_stats WHERE date = ?")
      .get(date) as Record<string, unknown> | undefined;
    if (!row) return { date, spentUsd: 0, realizedPnlUsd: 0, trades: 0 };
    return {
      date,
      spentUsd: Number(row.spent_usd),
      realizedPnlUsd: Number(row.realized_pnl_usd),
      trades: Number(row.trades),
    };
  }

  /** Live spend only — dry-run uses meta dry_spent separately when needed. */
  addSpend(usd: number, date = todayUtc()): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, spent_usd, realized_pnl_usd, trades) VALUES (?, ?, 0, 1)
         ON CONFLICT(date) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd, trades = trades + 1`,
      )
      .run(date, usd);
  }

  addRealizedPnl(usd: number, date = todayUtc()): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, spent_usd, realized_pnl_usd, trades) VALUES (?, 0, ?, 0)
         ON CONFLICT(date) DO UPDATE SET realized_pnl_usd = realized_pnl_usd + excluded.realized_pnl_usd`,
      )
      .run(date, usd);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  lastEntryAt(): number | null {
    const v = this.getMeta("last_entry_at");
    return v ? Number(v) : null;
  }

  setLastEntryAt(ts: number): void {
    this.setMeta("last_entry_at", String(ts));
  }

  loadAlumni(): Array<{
    userId: string;
    handle?: string;
    chains: string[];
    source: "leaderboard" | "manual";
    rank?: number;
  }> {
    const rows = this.db.prepare(`SELECT * FROM alumni`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      userId: String(r.user_id),
      handle: r.handle != null ? String(r.handle) : undefined,
      chains: JSON.parse(String(r.chains_json || "[]")) as string[],
      source: (r.source === "manual" ? "manual" : "leaderboard") as "leaderboard" | "manual",
      rank: r.rank != null ? Number(r.rank) : undefined,
    }));
  }

  replaceAlumni(
    rows: Array<{
      userId: string;
      handle?: string;
      chains: string[];
      source: string;
      rank?: number;
    }>,
  ): void {
    this.db.exec(`DELETE FROM alumni`);
    const ins = this.db.prepare(
      `INSERT INTO alumni (user_id, handle, chains_json, source, rank, updated_at) VALUES (?,?,?,?,?,?)`,
    );
    const now = new Date().toISOString();
    for (const r of rows) {
      ins.run(r.userId, r.handle ?? null, JSON.stringify(r.chains), r.source, r.rank ?? null, now);
    }
  }

  insertPendingSwap(p: {
    id: string;
    chain: string;
    side: "buy" | "sell";
    sourceEventId?: string | null;
    traderUserId?: string | null;
    traderHandle?: string | null;
    tokenAddress?: string | null;
    tokenSymbol?: string | null;
    sizeUsd?: number | null;
    sellToken?: string | null;
    buyToken?: string | null;
    inAmountRaw?: string | null;
    expectedOutRaw?: string | null;
    notes?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pending_swaps (
          id, created_at, updated_at, status, chain, side, source_event_id,
          trader_user_id, trader_handle, token_address, token_symbol, size_usd,
          sell_token, buy_token, in_amount_raw, expected_out_raw, tx_signature,
          position_id, error, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        now,
        now,
        "pending_broadcast",
        p.chain,
        p.side,
        p.sourceEventId ?? null,
        p.traderUserId ?? null,
        p.traderHandle ?? null,
        p.tokenAddress ?? null,
        p.tokenSymbol ?? null,
        p.sizeUsd ?? null,
        p.sellToken ?? null,
        p.buyToken ?? null,
        p.inAmountRaw ?? null,
        p.expectedOutRaw ?? null,
        null,
        null,
        null,
        p.notes ?? null,
      );
  }

  updatePendingSwap(
    id: string,
    patch: {
      status?: PendingSwapStatus;
      txSignature?: string | null;
      positionId?: string | null;
      error?: string | null;
      notes?: string | null;
      inAmountRaw?: string | null;
      expectedOutRaw?: string | null;
    },
  ): void {
    const cur = this.getPendingSwap(id);
    if (!cur) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pending_swaps SET updated_at=?, status=?, tx_signature=?, position_id=?,
         error=?, notes=?, in_amount_raw=?, expected_out_raw=? WHERE id=?`,
      )
      .run(
        now,
        patch.status ?? cur.status,
        patch.txSignature !== undefined ? patch.txSignature : cur.txSignature,
        patch.positionId !== undefined ? patch.positionId : cur.positionId,
        patch.error !== undefined ? patch.error : cur.error,
        patch.notes !== undefined ? patch.notes : cur.notes,
        patch.inAmountRaw !== undefined ? patch.inAmountRaw : cur.inAmountRaw,
        patch.expectedOutRaw !== undefined ? patch.expectedOutRaw : cur.expectedOutRaw,
        id,
      );
  }

  getPendingSwap(id: string): PendingSwap | null {
    const row = this.db.prepare(`SELECT * FROM pending_swaps WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToPending(row) : null;
  }

  /** Rows that still need attention after a crash / failed insertPosition. */
  listUnresolvedPending(): PendingSwap[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_swaps WHERE status IN (
           'pending_broadcast','broadcast','confirmed','unresolved'
         ) ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToPending);
  }

  markPendingReconciled(id: string, positionId: string): void {
    this.updatePendingSwap(id, { status: "reconciled", positionId });
  }


}


export type PendingSwapStatus =
  | "pending_broadcast"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "reconciled"
  | "unresolved";

export interface PendingSwap {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: PendingSwapStatus;
  chain: string;
  side: "buy" | "sell";
  sourceEventId: string | null;
  traderUserId: string | null;
  traderHandle: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  sizeUsd: number | null;
  sellToken: string | null;
  buyToken: string | null;
  inAmountRaw: string | null;
  expectedOutRaw: string | null;
  txSignature: string | null;
  positionId: string | null;
  error: string | null;
  notes: string | null;
}


function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function rowToPosition(row: Record<string, unknown>): OpenPosition {
  const sizeUsd = Number(row.size_usd);
  const remaining =
    row.remaining_usd != null && Number(row.remaining_usd) > 0
      ? Number(row.remaining_usd)
      : sizeUsd;
  return {
    id: String(row.id),
    traderUserId: row.trader_user_id != null ? String(row.trader_user_id) : null,
    traderHandle: row.trader_handle != null ? String(row.trader_handle) : null,
    tradeId: row.trade_id != null ? String(row.trade_id) : null,
    chain: row.chain as OpenPosition["chain"],
    tokenAddress: String(row.token_address),
    tokenSymbol: row.token_symbol != null ? String(row.token_symbol) : null,
    entryUsd: Number(row.entry_usd),
    sizeUsd,
    remainingUsd: remaining,
    quantityRaw: row.quantity_raw != null ? String(row.quantity_raw) : null,
    entryPriceUsd: row.entry_price_usd != null ? Number(row.entry_price_usd) : null,
    traderSizeAtEntryUsd:
      row.trader_size_at_entry_usd != null ? Number(row.trader_size_at_entry_usd) : null,
    traderTokenAmountAtEntry:
      row.trader_token_amount_at_entry != null ? Number(row.trader_token_amount_at_entry) : null,
    openedAt: String(row.opened_at),
    sourceEventId: String(row.source_event_id),
    status: row.status as OpenPosition["status"],
    isDryRun: Number(row.is_dry_run) === 1,
    closedAt: row.closed_at != null ? String(row.closed_at) : undefined,
    exitUsd: row.exit_usd != null ? Number(row.exit_usd) : undefined,
    exitReason: row.exit_reason != null ? String(row.exit_reason) : undefined,
    realizedPnlUsd: row.realized_pnl_usd != null ? Number(row.realized_pnl_usd) : undefined,
    txEntry: row.tx_entry != null ? String(row.tx_entry) : null,
    txExit: row.tx_exit != null ? String(row.tx_exit) : null,
  };
}

function rowToPending(row: Record<string, unknown>): PendingSwap {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: row.status as PendingSwapStatus,
    chain: String(row.chain),
    side: row.side === "sell" ? "sell" : "buy",
    sourceEventId: row.source_event_id != null ? String(row.source_event_id) : null,
    traderUserId: row.trader_user_id != null ? String(row.trader_user_id) : null,
    traderHandle: row.trader_handle != null ? String(row.trader_handle) : null,
    tokenAddress: row.token_address != null ? String(row.token_address) : null,
    tokenSymbol: row.token_symbol != null ? String(row.token_symbol) : null,
    sizeUsd: row.size_usd != null ? Number(row.size_usd) : null,
    sellToken: row.sell_token != null ? String(row.sell_token) : null,
    buyToken: row.buy_token != null ? String(row.buy_token) : null,
    inAmountRaw: row.in_amount_raw != null ? String(row.in_amount_raw) : null,
    expectedOutRaw: row.expected_out_raw != null ? String(row.expected_out_raw) : null,
    txSignature: row.tx_signature != null ? String(row.tx_signature) : null,
    positionId: row.position_id != null ? String(row.position_id) : null,
    error: row.error != null ? String(row.error) : null,
    notes: row.notes != null ? String(row.notes) : null,
  };
}

