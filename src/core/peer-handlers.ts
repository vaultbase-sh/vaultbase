/**
 * What this server does when another server on the same Postgres database
 * announces a change (core/peers.ts). Loaded by boot when peers start.
 */
import { getDriver } from "../db/index.ts";
import type { PostgresDriver } from "../db/postgres.ts";
import { onPeerMessage, type PeerMessage } from "./peers.ts";
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
