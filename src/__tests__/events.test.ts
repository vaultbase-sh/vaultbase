/**
 * The event bus: core code emits record and sign-up events; realtime,
 * webhooks and after-hooks are listeners on it, and so is anything an
 * extension registers.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, deleteRecord, updateRecord } from "../core/records.ts";
import { emit, listenerCount, on, type VaultbaseEvents } from "../core/events.ts";
import { makeAuthPlugin } from "../api/auth.ts";

const offs: Array<() => void> = [];
function listen<E extends keyof VaultbaseEvents>(event: E): Array<VaultbaseEvents[E]> {
  const seen: Array<VaultbaseEvents[E]> = [];
  offs.push(on(event, (p) => { seen.push(p); }, "test"));
  return seen;
}

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
  closeDb();
});

describe("event bus", () => {
  it("runs listeners in order, and one failing doesn't stop the rest", async () => {
    const order: string[] = [];
    offs.push(on("auth.signup", () => { order.push("a"); throw new Error("boom"); }, "a"));
    offs.push(on("auth.signup", async () => { order.push("b"); throw new Error("async boom"); }, "b"));
    offs.push(on("auth.signup", () => { order.push("c"); }, "c"));
    const errors = console.error;
    console.error = () => {};
    try {
      emit("auth.signup", { collection: {} as never, record: {}, method: "password" });
      await Bun.sleep(0);
    } finally {
      console.error = errors;
    }
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("removes a listener with the function on() returns", () => {
    const before = listenerCount("auth.signup");
    const off = on("auth.signup", () => {});
    expect(listenerCount("auth.signup")).toBe(before + 1);
    off();
    expect(listenerCount("auth.signup")).toBe(before);
  });
});

describe("record events", () => {
  it("emits created, updated and deleted with the record and its source", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const created = listen("record.created");
    const updated = listen("record.updated");
    const deleted = listen("record.deleted");

    const r = await createRecord("posts", { title: "one" }, null);
    await updateRecord("posts", r.id, { title: "two" }, null);
    await deleteRecord("posts", r.id, null);

    expect(created).toHaveLength(1);
    expect(created[0]!.record["title"]).toBe("one");
    expect(created[0]!.collection.name).toBe("posts");
    expect(created[0]!.source).toBe("api");
    expect(updated[0]!.record["title"]).toBe("two");
    expect(updated[0]!.existing?.["title"]).toBe("one");
    expect(deleted[0]!.id).toBe(r.id);
    expect(deleted[0]!.existing["title"]).toBe("two");
  });

  it("marks relations cleared by a delete as cascade updates", async () => {
    await createCollection({ name: "projects", fields: JSON.stringify([{ name: "name", type: "text" }]) });
    await createCollection({
      name: "tasks",
      fields: JSON.stringify([{ name: "project", type: "relation", collection: "projects", options: { cascade: "setNull" } }]),
    });
    const p = await createRecord("projects", { name: "p" }, null);
    const t = await createRecord("tasks", { project: p.id }, null);
    const updated = listen("record.updated");

    await deleteRecord("projects", p.id, null);

    expect(updated).toHaveLength(1);
    expect(updated[0]!.record["id"]).toBe(t.id);
    expect(updated[0]!.record["project"]).toBeNull();
    expect(updated[0]!.collection.name).toBe("tasks");
    expect(updated[0]!.source).toBe("cascade");
  });

  it("emits a sign-up, and the new user as an auth-sourced record", async () => {
    await createCollection({ name: "users", type: "auth", create_rule: null, fields: JSON.stringify([]), view_rule: null });
    const { settings } = await import("../db/schema.ts");
    await getDb().insert(settings).values({ key: "auth.anonymous.enabled", value: "1", updated_at: Math.floor(Date.now() / 1000) });
    const signups = listen("auth.signup");
    const created = listen("record.created");

    const res = await makeAuthPlugin("test-secret-events").handle(
      new Request("http://localhost/auth/users/anonymous", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { data: { record: { id: string } } }).data.record.id;

    expect(signups).toHaveLength(1);
    expect(signups[0]!.method).toBe("anonymous");
    expect(signups[0]!.record["id"]).toBe(id);
    expect(created.map((c) => [c.record["id"], c.source])).toEqual([[id, "auth"]]);
  });
});
