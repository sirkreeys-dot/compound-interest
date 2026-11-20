/**
 * After a restart, every swap that was signed and recorded is resolved from
 * Solana RPC only (no Jupiter): confirmed, failed, expired, or unknown.
 * Wallet token balance wins over the quoted amount. Unknown rows are not retried.
 */
import { Connection } from "@solana/web3.js";
import type { EnvConfig } from "../config.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import type { AppConfig } from "../types.js";
import { log } from "../utils/logger.js";
import { rpcConnection } from "../utils/http.js";
import { redactSecrets } from "../security/redact.js";
import type { PendingSwap, Store } from "./db.js";
import { randomUUID } from "node:crypto";

export type PendingOutcome = "confirmed" | "failed" | "expired" | "unknown";

export async function reconcilePendingSwaps(opts: {
  store: Store;
  env: EnvConfig;
  cfg: AppConfig;
  tg: TelegramNotifier;
  rpcUrl: string;
  connection?: Connection;
  getSignatureStatuses?: (
    sigs: string[],
  ) => Promise<Array<{ confirmationStatus?: string | null; err?: unknown } | null>>;
  /** On-chain token balance. Quote amounts are not used when this is absent. */
  getWalletTokenAmount?: (mint: string) => Promise<string | null>;
  /** True while the stored blockhash can still land. */
  isBlockhashValid?: (blockhash: string) => Promise<boolean>;
  getBlockHeight?: () => Promise<number>;
}): Promise<{ resolved: number; unresolved: number }> {
  const rows = opts.store.listUnresolvedPending();
  if (!rows.length) return { resolved: 0, unresolved: 0 };

  log.warn(`Reconciling ${rows.length} unresolved pending swap(s)…`);
  let resolved = 0;
  let unresolved = 0;

  const conn =
    opts.connection ??
    (opts.rpcUrl && !/127\.0\.0\.1|localhost/i.test(opts.rpcUrl) ? rpcConnection(opts.rpcUrl) : null);

  for (const row of rows) {
    try {
      const r = await reconcileOne(row, { ...opts, conn });
      if (r === "resolved") resolved++;
      else unresolved++;
    } catch (e) {
      unresolved++;
      log.warn(`Pending reconcile failed for ${row.id}`, e);
      opts.store.updatePendingSwap(row.id, {
        status: "unknown",
        error: e instanceof Error ? e.message : String(e),
      });
      await opts.tg.send(
        `<b>⚠️ Pending swap unknown</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature ?? "?"}</code>\n${redactSecrets(e instanceof Error ? e.message : String(e))}\nNot retrying. Will check again.`,
      );
    }
  }
  return { resolved, unresolved };
}

async function blockhashStillValid(
  row: PendingSwap,
  opts: {
    conn: Connection | null;
    isBlockhashValid?: (blockhash: string) => Promise<boolean>;
    getBlockHeight?: () => Promise<number>;
  },
): Promise<boolean | null> {
  if (row.blockhash) {
    try {
      if (opts.isBlockhashValid) return await opts.isBlockhashValid(row.blockhash);
      if (opts.conn) {
        const res = await opts.conn.isBlockhashValid(row.blockhash, { commitment: "confirmed" });
        return res.value;
      }
    } catch {
      return null;
    }
  }
  if (row.lastValidBlockHeight != null) {
    try {
      const height = opts.getBlockHeight
        ? await opts.getBlockHeight()
        : opts.conn
          ? await opts.conn.getBlockHeight("confirmed")
          : null;
      if (height == null) return null;
      return height <= row.lastValidBlockHeight;
    } catch {
      return null;
    }
  }
  return null;
}

/** Classify a signature that was stored before broadcast. RPC errors stay unknown. */
export async function classifyPendingSignature(
  row: PendingSwap,
  opts: {
    conn: Connection | null;
    getSignatureStatuses?: (
      sigs: string[],
    ) => Promise<Array<{ confirmationStatus?: string | null; err?: unknown } | null>>;
    isBlockhashValid?: (blockhash: string) => Promise<boolean>;
    getBlockHeight?: () => Promise<number>;
  },
): Promise<PendingOutcome> {
  if (!row.txSignature) return "unknown";
  let status: { confirmationStatus?: string | null; err?: unknown } | null = null;
  let rpcFailed = false;
  try {
    if (opts.getSignatureStatuses) {
      const arr = await opts.getSignatureStatuses([row.txSignature]);
      status = arr[0] ?? null;
    } else if (opts.conn) {
      const res = await opts.conn.getSignatureStatuses([row.txSignature], {
        searchTransactionHistory: true,
      });
      status = res?.value?.[0] ?? null;
    } else {
      rpcFailed = true;
    }
  } catch {
    rpcFailed = true;
  }
  if (rpcFailed) return "unknown";
  if (status?.err) return "failed";
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
    return "confirmed";
  }
  let valid: boolean | null = null;
  try {
    valid = await blockhashStillValid(row, opts);
  } catch {
    return "unknown";
  }
  if (valid == null) return "unknown";
  if (!status && valid === false) return "expired";
  return "unknown";
}

async function reconcileOne(
  row: PendingSwap,
  opts: {
    store: Store;
    cfg: AppConfig;
    tg: TelegramNotifier;
    conn: Connection | null;
    getSignatureStatuses?: (
      sigs: string[],
    ) => Promise<Array<{ confirmationStatus?: string | null; err?: unknown } | null>>;
    getWalletTokenAmount?: (mint: string) => Promise<string | null>;
    isBlockhashValid?: (blockhash: string) => Promise<boolean>;
    getBlockHeight?: () => Promise<number>;
  },
): Promise<"resolved" | "unresolved"> {
  if (row.status === "failed" || row.status === "expired") return "resolved";

  if (!row.txSignature) {
    const note = row.notes?.includes("requestId=")
      ? row.notes
      : "no signature or request id on disk";
    opts.store.updatePendingSwap(row.id, {
      status: "unresolved",
      error: "startup: not proven safe — no signature to check",
      notes: note,
    });
    await opts.tg.send(
      `<b>⚠️ Pending ${row.side} not proven safe</b>\nid=<code>${row.id}</code>\nNo signature was stored before broadcast. Check the wallet before trading again.`,
    );
    return "unresolved";
  }

  const outcome = await classifyPendingSignature(row, opts);
  if (outcome === "failed") {
    opts.store.updatePendingSwap(row.id, {
      status: "failed",
      error: "on-chain err",
    });
    releaseForRetry(opts.store, row);
    await opts.tg.send(
      `<b>Pending ${row.side} failed on-chain</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>\nSafe to retry.`,
    );
    return "resolved";
  }
  if (outcome === "expired") {
    opts.store.updatePendingSwap(row.id, {
      status: "expired",
      error: "blockhash expired and signature was not found",
    });
    releaseForRetry(opts.store, row);
    await opts.tg.send(
      `<b>Pending ${row.side} expired</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>\nBlockhash is dead. Safe to retry.`,
    );
    return "resolved";
  }
  if (outcome === "confirmed") {
    const applied = await applyConfirmed(row, opts);
    return applied ? "resolved" : "unresolved";
  }

  const already = row.status === "unknown";
  opts.store.updatePendingSwap(row.id, {
    status: "unknown",
    error: "signature not final and blockhash may still be valid",
    notes: "recheck later — do not retry",
  });
  if (!already) {
    await opts.tg.send(
      `<b>⚠️ Pending ${row.side} unknown</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>\nNot retrying. Will check again.`,
    );
  }
  return "unresolved";
}

function releaseForRetry(store: Store, row: PendingSwap): void {
  if (row.side !== "sell" || !row.positionId) return;
  const stillInFlight = store.listUnresolvedPending().some(
    (p) => p.id !== row.id && p.positionId === row.positionId && p.txSignature,
  );
  if (stillInFlight) return;
  const pos = store.getPosition(row.positionId);
  if (pos && pos.status === "closing") store.revertClosingToOpen(row.positionId);
}

async function applyConfirmed(
  row: PendingSwap,
  opts: {
    store: Store;
    tg: TelegramNotifier;
    getWalletTokenAmount?: (mint: string) => Promise<string | null>;
  },
): Promise<boolean> {
  const mint = row.side === "sell" ? row.sellToken ?? row.tokenAddress : row.tokenAddress;
  if (!mint) {
    opts.store.updatePendingSwap(row.id, {
      status: "unknown",
      error: "confirmed signature but mint is missing",
    });
    return false;
  }
  const walletAmt = opts.getWalletTokenAmount ? await opts.getWalletTokenAmount(mint) : null;
  if (walletAmt == null || !/^\d+$/.test(walletAmt)) {
    opts.store.updatePendingSwap(row.id, {
      status: "unknown",
      error: "confirmed signature but wallet balance was not read — quote amount was not trusted",
    });
    await opts.tg.send(
      `<b>⚠️ Confirmed ${row.side} needs a wallet balance</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>`,
    );
    return false;
  }

  if (row.side === "sell") return applyConfirmedSell(row, walletAmt, opts);
  return applyConfirmedBuy(row, walletAmt, opts);
}

function applyConfirmedBuy(
  row: PendingSwap,
  walletAmt: string,
  opts: { store: Store; tg: TelegramNotifier },
): boolean {
  const open = opts.store.findOpenByTraderToken(
    row.traderUserId ?? row.traderHandle ?? "",
    row.tokenAddress ?? "",
    row.chain,
  );
  if (open) {
    opts.store.syncPositionToWallet(open.id, walletAmt, open.remainingUsd);
    opts.store.markPendingReconciled(row.id, open.id);
    return true;
  }
  const posId = randomUUID();
  try {
    opts.store.insertPosition({
      id: posId,
      traderUserId: row.traderUserId,
      traderHandle: row.traderHandle,
      tradeId: null,
      chain: row.chain as "solana",
      tokenAddress: row.tokenAddress ?? "",
      tokenSymbol: row.tokenSymbol,
      entryUsd: row.sizeUsd ?? 0,
      sizeUsd: row.sizeUsd ?? 0,
      remainingUsd: row.sizeUsd ?? 0,
      quantityRaw: walletAmt,
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: row.createdAt,
      sourceEventId: row.sourceEventId ?? `pending:${row.id}`,
      status: "open",
      isDryRun: false,
      txEntry: row.txSignature ?? undefined,
    });
    if (row.sizeUsd) opts.store.addSpend(row.sizeUsd);
    opts.store.markPendingReconciled(row.id, posId);
    void opts.tg.send(
      `<b>♻️ Reconciled pending buy</b>\nRecovered position <code>${posId}</code> from pending <code>${row.id}</code>\ntx=<code>${row.txSignature}</code>\ntoken=<code>${row.tokenAddress}</code>\nqty=<code>${walletAmt}</code>`,
    );
    return true;
  } catch (e) {
    opts.store.updatePendingSwap(row.id, {
      status: "unknown",
      error: `reconcile insert failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    void opts.tg.send(
      `<b>⚠️ Pending buy needs manual review</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>`,
    );
    return false;
  }
}

function applyConfirmedSell(
  row: PendingSwap,
  walletAmt: string,
  opts: { store: Store; tg: TelegramNotifier },
): boolean {
  const pos = row.positionId
    ? opts.store.getPosition(row.positionId)
    : opts.store.findOpenByTraderToken(
        row.traderUserId ?? row.traderHandle ?? "",
        row.tokenAddress ?? row.sellToken ?? "",
        row.chain,
      );
  if (!pos) {
    opts.store.markPendingReconciled(row.id, row.positionId ?? row.id);
    return true;
  }
  if (pos.status === "closed" || pos.status === "dry_closed" || pos.status === "written_off") {
    opts.store.markPendingReconciled(row.id, pos.id);
    return true;
  }
  if (walletAmt === "0") {
    opts.store.applyPartialClose(pos.id, {
      soldRaw: pos.quantityRaw ?? "0",
      remainingRaw: "0",
      remainingUsd: 0,
      realizedPnlUsd: 0,
      fullyClosed: true,
      isDryRun: pos.isDryRun,
      exitReason: "reconcile_wallet",
      exitUsd: 0,
      txExit: row.txSignature ?? undefined,
    });
  } else {
    const prev = pos.quantityRaw && /^\d+$/.test(pos.quantityRaw) ? BigInt(pos.quantityRaw) : 0n;
    const next = BigInt(walletAmt);
    const remaining =
      prev > 0n ? (pos.remainingUsd * Number(next)) / Number(prev) : pos.remainingUsd;
    opts.store.syncPositionToWallet(pos.id, walletAmt, remaining);
  }
  opts.store.markPendingReconciled(row.id, pos.id);
  void opts.tg.send(
    `<b>♻️ Reconciled pending sell</b>\nposition <code>${pos.id}</code>\nwallet qty=<code>${walletAmt}</code>\ntx=<code>${row.txSignature}</code>`,
  );
  return true;
}
