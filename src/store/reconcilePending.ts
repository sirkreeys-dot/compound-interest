/**
 * On startup, resolve pending_swaps that never made it into positions.
 * Prefer signature status via RPC; fall back to marking unresolved + Telegram alert.
 */
import { Connection } from "@solana/web3.js";
import type { EnvConfig } from "../config.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import type { AppConfig } from "../types.js";
import { log } from "../utils/logger.js";
import { redactSecrets } from "../security/redact.js";
import type { PendingSwap, Store } from "./db.js";
import { randomUUID } from "node:crypto";

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
}): Promise<{ resolved: number; unresolved: number }> {
  const rows = opts.store.listUnresolvedPending();
  if (!rows.length) return { resolved: 0, unresolved: 0 };

  log.warn(`Reconciling ${rows.length} unresolved pending swap(s)…`);
  let resolved = 0;
  let unresolved = 0;

  const conn =
    opts.connection ??
    (opts.rpcUrl && !/127\.0\.0\.1|localhost/i.test(opts.rpcUrl)
      ? new Connection(opts.rpcUrl, "confirmed")
      : null);

  for (const row of rows) {
    try {
      const r = await reconcileOne(row, { ...opts, conn });
      if (r === "resolved") resolved++;
      else unresolved++;
    } catch (e) {
      unresolved++;
      log.warn(`Pending reconcile failed for ${row.id}`, e);
      opts.store.updatePendingSwap(row.id, {
        status: "unresolved",
        error: e instanceof Error ? e.message : String(e),
      });
      await opts.tg.send(
        `<b>⚠️ Pending swap unresolved</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature ?? "?"}</code>\n${redactSecrets(e instanceof Error ? e.message : String(e))}`,
      );
    }
  }
  return { resolved, unresolved };
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
  },
): Promise<"resolved" | "unresolved"> {
  // Already failed cleanly — leave as failed (not in unresolved list normally)
  if (row.status === "failed") {
    return "resolved";
  }

  // pending_broadcast with no signature: never sent — mark failed
  if (row.status === "pending_broadcast" && !row.txSignature) {
    opts.store.updatePendingSwap(row.id, {
      status: "failed",
      error: "startup: never broadcast",
    });
    await opts.tg.send(
      `<b>Pending buy abandoned</b>\nid=<code>${row.id}</code> never reached broadcast (safe).`,
    );
    return "resolved";
  }

  // Have a signature — check RPC status
  if (row.txSignature) {
    let status: { confirmationStatus?: string | null; err?: unknown } | null = null;
    if (opts.getSignatureStatuses) {
      const arr = await opts.getSignatureStatuses([row.txSignature]);
      status = arr[0] ?? null;
    } else if (opts.conn) {
      const res = await opts.conn.getSignatureStatuses([row.txSignature]);
      status = res?.value?.[0] ?? null;
    }

    if (status?.err) {
      opts.store.updatePendingSwap(row.id, {
        status: "failed",
        error: `on-chain err: ${JSON.stringify(status.err)}`.slice(0, 500),
      });
      await opts.tg.send(
        `<b>Pending buy failed on-chain</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>`,
      );
      return "resolved";
    }

    const confirmed =
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized" ||
      row.status === "confirmed";

    if (confirmed && row.tokenAddress && row.side === "buy") {
      // Create a position from the pending row if none exists for this event
      const existing = row.sourceEventId
        ? null // we don't have getBySourceEvent — check open by token+trader
        : null;
      void existing;
      const open = opts.store.findOpenByTraderToken(
        row.traderUserId ?? row.traderHandle ?? "",
        row.tokenAddress,
        row.chain,
      );
      if (open) {
        opts.store.markPendingReconciled(row.id, open.id);
        return "resolved";
      }
      // Insert a recovery position using expected/known amounts
      const posId = randomUUID();
      try {
        opts.store.insertPosition({
          id: posId,
          traderUserId: row.traderUserId,
          traderHandle: row.traderHandle,
          tradeId: null,
          chain: row.chain as "solana",
          tokenAddress: row.tokenAddress,
          tokenSymbol: row.tokenSymbol,
          entryUsd: row.sizeUsd ?? 0,
          sizeUsd: row.sizeUsd ?? 0,
          remainingUsd: row.sizeUsd ?? 0,
          quantityRaw: row.expectedOutRaw ?? "0",
          entryPriceUsd: null,
          traderSizeAtEntryUsd: null,
          traderTokenAmountAtEntry: null,
          openedAt: row.createdAt,
          sourceEventId: row.sourceEventId ?? `pending:${row.id}`,
          status: "open",
          isDryRun: false,
          txEntry: row.txSignature,
        });
        if (row.sizeUsd) opts.store.addSpend(row.sizeUsd);
        opts.store.markPendingReconciled(row.id, posId);
        await opts.tg.send(
          `<b>♻️ Reconciled pending buy</b>\nRecovered position <code>${posId}</code> from pending <code>${row.id}</code>\ntx=<code>${row.txSignature}</code>\ntoken=<code>${row.tokenAddress}</code>`,
        );
        return "resolved";
      } catch (e) {
        opts.store.updatePendingSwap(row.id, {
          status: "unresolved",
          error: `reconcile insert failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        await opts.tg.send(
          `<b>⚠️ Pending buy needs manual review</b>\nid=<code>${row.id}</code>\ntx=<code>${row.txSignature}</code>\ntoken=<code>${row.tokenAddress}</code>`,
        );
        return "unresolved";
      }
    }
  }

  opts.store.updatePendingSwap(row.id, {
    status: "unresolved",
    notes: "startup could not confirm — manual review",
  });
  await opts.tg.send(
    `<b>⚠️ Pending swap unresolved</b>\nid=<code>${row.id}</code>\nstatus=${row.status}\ntx=<code>${row.txSignature ?? "none"}</code>\ntoken=<code>${row.tokenAddress ?? "?"}</code>`,
  );
  return "unresolved";
}
