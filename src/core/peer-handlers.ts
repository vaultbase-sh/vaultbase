/**
 * What this server does when another server on the same Postgres database
 * announces a change (core/peers.ts). Loaded by boot when peers start.
 */
import { getDriver } from "../db/index.ts";
import type { PostgresDriver } from "../db/postgres.ts";
import { onPeerMessage, resetPeerCaches, type PeerMessage } from "./peers.ts";
import { withExclusiveWrite } from "./write-gate.ts";
import type { BusMessage } from "./thread-bus.ts";
import { applyTableReport } from "./table-writes.ts";
import { _resetCollectionCache, getCollection, invalidateSensitiveSchema, invalidateUserTableColumnCache } from "./collections.ts";
import { getRecord } from "./records.ts";
import { invalidateRecordVectors, _resetVectorCache } from "./vector-cache.ts";
import { _reloadSettings, invalidateSetting } from "../api/settings.ts";
import { invalidateRateLimitCache } from "../api/ratelimit.ts";
import { invalidateEmailCache } from "./email.ts";
import { clearThumbCache, invalidateStorageCache } from "./storage.ts";
import { invalidateEgressCache } from "./hook-egress.ts";
import { invalidateCorsCache } from "./cors.ts";
import { broadcast as realtimeBroadcast, broadcastRules, broadcastSystem } from "../realtime/manager.ts";

/** Collections, rules or tables changed on another server. */
function schemaChanged(): void {
  (getDriver() as PostgresDriver).noteForeignSchemaChange?.();
  _resetCollectionCache();
  invalidateSensitiveSchema();
  invalidateUserTableColumnCache();
  _resetVectorCache();
}

/** The caches built from settings, as the settings PATCH drops them. */
function settingsCachesChanged(): void {
  invalidateRateLimitCache();
  invalidateEmailCache();
  invalidateStorageCache();
  clearThumbCache();
  invalidateEgressCache();
  invalidateCorsCache();
}

// Thread-bus messages, relayed (core/thread-bus.ts). With no data: after a
// reconnect, everything they cover.
onPeerMessage("bus", async (msg) => {
  const m = msg["m"] as BusMessage | undefined;
  if (!m) {
    schemaChanged();
    await _reloadSettings();
    settingsCachesChanged();
    return;
  }
  switch (m.kind) {
    case "tables":
      for (const [table] of m.tables) applyTableReport(table, 0);
      break;
    case "collections":
      schemaChanged();
      break;
    case "settings":
      await invalidateSetting(m.key);
      settingsCachesChanged();
      break;
  }
}, { reset: true });

/**
 * A record written through another server: its cached vectors go, and this
 * server's realtime subscribers hear about it, judged by this server's
 * rules. A record too large for one NOTIFY arrives without its body and is
 * read back (a deleted one is then judged without it).
 */
onPeerMessage("rec", async (msg: PeerMessage) => {
  const name = msg["c"] as string, id = msg["id"] as string, type = msg["t"] as "create" | "update" | "delete";
  const col = await getCollection(name);
  if (!col) return;
  invalidateRecordVectors(col.id, id);
  if (msg["src"] === "auth") return;
  const record = (msg["r"] as Record<string, unknown> | undefined) ?? (type === "delete" ? null : await getRecord(name, id));
  if (type !== "delete" && !record) return;
  const opts = { ...broadcastRules(col), record: record ?? {} };
  if (type === "delete") realtimeBroadcast(name, { type, collection: name, id }, opts);
  else realtimeBroadcast(name, { type, collection: name, record: record as never }, opts);
});

onPeerMessage("sys", (msg) => {
  broadcastSystem(msg["topic"] as string, msg["message"] as object);
});

/**
 * Another server is about to swap restored data in (core/pg-restore.ts):
 * writes here wait, so none lands on a table being moved or from a cache
 * about to go stale, until it says it's done or `ms` runs out. It repeats
 * the message while it works, each repeat moving the deadline; one that
 * stops repeating has died, and writes carry on once the last deadline
 * passes, with every cache dropped, since the swap may have committed.
 * Reads go on; they wait on the swap's locks and then read the restored
 * tables.
 */
const MAX_HOLD_MS = 120_000;
let hold: { renew: (ms: number) => void; release: () => void } | null = null;
onPeerMessage("restore:begin", (msg) => {
  const ms = Math.min(Math.max(Number(msg["ms"]) || 0, 0), MAX_HOLD_MS);
  if (hold) { hold.renew(ms); return; }
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let timer: ReturnType<typeof setTimeout>;
  const expire = () => { if (hold === current) { hold = null; release(); resetPeerCaches(); } };
  const current = {
    renew: (next: number) => { clearTimeout(timer); timer = setTimeout(expire, next); },
    // Cleared here, not once the gate is let go: a hold asked for right
    // after this one ends must not be taken for this one.
    release: () => { clearTimeout(timer); if (hold === current) hold = null; release(); },
  };
  hold = current;
  current.renew(ms);
  // Not awaited: the messages after this one must still be handled.
  void withExclusiveWrite(async (tx) => { await released; tx.commit(); }).catch(() => { /* nothing ran inside */ });
});

/** The swap is done, or failed: everything cached goes, and writes carry on. */
onPeerMessage("cache:restored", () => {
  hold?.release();
  resetPeerCaches();
});
