/**
 * The built-in listeners on the event bus: realtime, outbound webhooks and
 * after-hooks, in that order. Imported for its side effect by the modules
 * that emit record events, so they're registered before the first write.
 */
import { broadcast } from "../realtime/manager.ts";
import { on } from "./events.ts";
import { makeHookHelpers, runAfterHook } from "./hooks.ts";
import { dispatchEvent } from "./webhooks.ts";
import { sendToPeers, withSlim } from "./peers.ts";

let registered = false;

export function registerBuiltinListeners(): void {
  if (registered) return;
  registered = true;

  // Realtime. Users created by auth flows aren't broadcast (they never were).
  on("record.created", ({ collection: col, record, source }) => {
    if (source === "auth") return;
    broadcast(col.name, { type: "create", collection: col.name, record: record as never }, {
      viewRule: col.view_rule, listRule: col.list_rule, record,
    });
  }, "realtime");
  on("record.updated", ({ collection: col, record, source }) => {
    if (source === "auth") return;
    broadcast(col.name, { type: "update", collection: col.name, record: record as never }, {
      viewRule: col.view_rule, listRule: col.list_rule, record,
    });
  }, "realtime");
  on("record.deleted", ({ collection: col, id, existing, source }) => {
    if (source === "auth") return;
    broadcast(col.name, { type: "delete", collection: col.name, id }, {
      viewRule: col.view_rule, listRule: col.list_rule, record: existing,
    });
  }, "realtime");

  // Other servers on the same Postgres database: their realtime subscribers
  // and vector caches (core/peer-handlers.ts). Every source: vectors go
  // stale for auth-created users too.
  const toPeers = (t: string, c: string, id: string, r: Record<string, unknown> | undefined, src: string) => {
    const slim = { k: "rec", t, c, id, src };
    sendToPeers(withSlim({ ...slim, ...(r ? { r } : {}) }, slim));
  };
  on("record.created", ({ collection, record, source }) => toPeers("create", collection.name, String(record["id"]), record, source), "peers");
  on("record.updated", ({ collection, record, source }) => toPeers("update", collection.name, String(record["id"]), record, source), "peers");
  on("record.deleted", ({ collection, id, existing, source }) => toPeers("delete", collection.name, id, existing, source), "peers");

  // Outbound webhooks: `<collection>.create|update|delete`. Not for cascades
  // or auth-created users.
  const direct = (s: string) => s === "api";
  on("record.created", ({ collection, record, source }) => {
    if (direct(source)) return dispatchEvent({ event: `${collection.name}.create`, data: { record } }).then(() => {}, () => { /* best effort, as before */ });
  }, "webhooks");
  on("record.updated", ({ collection, record, source }) => {
    if (direct(source)) return dispatchEvent({ event: `${collection.name}.update`, data: { record } }).then(() => {}, () => { /* best effort, as before */ });
  }, "webhooks");
  on("record.deleted", ({ collection, id, existing, source }) => {
    if (direct(source)) return dispatchEvent({ event: `${collection.name}.delete`, data: { id, record: existing } }).then(() => {}, () => { /* best effort, as before */ });
  }, "webhooks");

  // After-hooks. Cascades skip them: they're bulk, and per-row hooks would be
  // surprisingly expensive.
  on("record.created", ({ collection, record, auth, source }) => {
    if (source === "cascade") return;
    runAfterHook(collection, "afterCreate", { record, existing: null, auth, helpers: makeHookHelpers() });
  }, "after-hooks");
  on("record.updated", ({ collection, record, existing, auth, source }) => {
    if (source === "cascade") return;
    runAfterHook(collection, "afterUpdate", { record, existing, auth, helpers: makeHookHelpers() });
  }, "after-hooks");
  on("record.deleted", ({ collection, existing, auth, source }) => {
    if (source === "cascade") return;
    runAfterHook(collection, "afterDelete", { record: {}, existing, auth, helpers: makeHookHelpers() });
  }, "after-hooks");
}

registerBuiltinListeners();
