/**
 * A batch that reads before it writes, while another connection of the
 * process briefly holds SQLite's write lock (the background checkpointer's
 * RESTART does, under steady writes). The batch's transaction used to start deferred:
 * its first write then had to upgrade a read transaction, which SQLite
 * refuses at once with "database is locked", without waiting, and the
 * batch failed with 500. It now takes the write lock up front and waits.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { _resetCollectionCache, createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, deleteRecord } from "../core/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

let dir: string;
let file: string;
let author: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-batch-lock-"));
  file = join(dir, "data.db");
  await initDb(file);
  await runMigrations();
  await createPublicCollection({ name: "authors", fields: JSON.stringify([{ name: "name", type: "text" }]) });
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([{ name: "title", type: "text" }, { name: "author", type: "relation", collection: "authors" }]),
  });
  author = (await createRecord("authors", { name: "a" }) as { id: string }).id;
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * What the background checkpointer does under steady writes, from a worker
 * thread of this process: `wal_checkpoint(RESTART)` with a 100 ms busy
 * timeout, over and over. Returns a function that stops it.
 */
async function checkpointNonstop(): Promise<() => Promise<number>> {
  const code = `
    const { Database } = require("bun:sqlite");
    let stop = false, restarts = 0;
    onmessage = async (e) => {
      if (e.data === "stop") { stop = true; return; }
      const db = new Database(e.data);
      db.exec("PRAGMA busy_timeout = 100");
      const restart = db.prepare("PRAGMA wal_checkpoint(RESTART)");
      postMessage("started");
      while (!stop) {
        if (!restart.get().busy) restarts++;
        await Bun.sleep(1);
      }
      restart.finalize();
      db.close();
      postMessage(restarts);
    };
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  await new Promise<void>((started) => {
    worker.onmessage = () => started();
    worker.postMessage(file);
  });
  return () => new Promise<number>((done) => {
    worker.onmessage = (e) => { worker.terminate(); done(e.data as number); };
    worker.postMessage("stop");
  });
}

describe.skipIf(!onSqlite)("a batch while another connection holds the write lock", () => {
  // Each create reads first (the table's columns, the relation), so a
  // deferred transaction had a read open when it came to write.
  it("waits for the lock instead of failing with database is locked", async () => {
    const stop = await checkpointNonstop();
    const plugin = makeBatchPlugin("test-secret-batch-lock");
    const failures: string[] = [];
    try {
      for (let i = 0; i < 150; i++) {
        const res = await plugin.handle(new Request("http://localhost/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requests: Array.from({ length: 20 }, (_, j) => ({
              method: "POST", url: "/api/v1/posts", body: { title: `post ${i}.${j}`, author },
            })),
          }),
        }));
        if (res.status !== 200) failures.push(`${res.status} ${JSON.stringify(await res.json())}`);
      }
    } finally {
      expect(await stop()).toBeGreaterThan(0);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("a cascading delete, field changes and a new search index wait too", async () => {
    await createPublicCollection({
      name: "notes",
      fields: JSON.stringify([{ name: "post", type: "relation", collection: "posts", options: { cascadeDelete: true } }]),
    });
    const posts: string[] = [];
    for (let i = 0; i < 100; i++) {
      const p = await createRecord("posts", { title: `p${i}`, author }) as { id: string };
      await createRecord("notes", { post: p.id });
      posts.push(p.id);
    }
    const grows = await createCollection({ name: "grows", fields: JSON.stringify([{ name: "f0", type: "text" }]) });
    const stop = await checkpointNonstop();
    const failures: string[] = [];
    try {
      for (let i = 1; i <= 20; i++) {
        const fields = Array.from({ length: i + 1 }, (_, j) => ({ name: `f${j}`, type: "text" }));
        await updateCollection(grows.id, { fields: JSON.stringify(fields) })
          .catch((e) => failures.push(`add a field: ${(e as Error).message}`));
      }
      for (const id of posts) {
        await deleteRecord("posts", id).catch((e) => failures.push(`delete: ${(e as Error).message}`));
      }
      for (let i = 0; i < 20; i++) {
        await createCollection({
          name: `searchable_${i}`, fields: JSON.stringify([{ name: "body", type: "text", options: { searchable: true } }]),
        }).catch((e) => failures.push(`create collection: ${(e as Error).message}`));
      }
    } finally {
      expect(await stop()).toBeGreaterThan(0);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
