/**
 * Storage drivers an extension registers: selected by `storage.driver`,
 * used for every read and write, and refused in settings when missing.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import {
  deleteFile, fileExists, fileResponse, getStorageStatus, invalidateStorageCache, listStorageDrivers,
  publicUrlFor, readFile, registerStorageDriver, testStorage, writeFile,
} from "../core/storage.ts";

const objects = new Map<string, Uint8Array>();
let created = 0;
let off: () => void;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  objects.clear();
  created = 0;
  off = registerStorageDriver({
    name: "memory",
    create: ({ settings }) => {
      created++;
      const prefix = settings["storage.memory.prefix"] ?? "";
      return {
        async write(key, data) { objects.set(prefix + key, new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)); },
        async read(key) { const b = objects.get(prefix + key); return b ? b.slice().buffer : null; },
        async exists(key) { return objects.has(prefix + key); },
        async delete(key) { objects.delete(prefix + key); },
        publicUrl: (key) => `https://cdn.test/${key}`,
        status: () => ({ prefix }),
      };
    },
  });
  invalidateStorageCache();
});

afterEach(() => {
  off();
  invalidateStorageCache();
  closeDb();
});

describe("registered storage drivers", () => {
  it("handles reads and writes once selected in settings", async () => {
    setSetting("storage.driver", "memory");
    setSetting("storage.memory.prefix", "p/");
    invalidateStorageCache();

    await writeFile("a.txt", new TextEncoder().encode("hello"));
    expect([...objects.keys()]).toEqual(["p/a.txt"]);
    expect(await fileExists("a.txt")).toBe(true);
    expect(new TextDecoder().decode((await readFile("a.txt"))!)).toBe("hello");

    // No response() of its own: served from read(), as an opaque type.
    const res = (await fileResponse("a.txt"))!;
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("hello");
    expect(await fileResponse("missing")).toBeNull();

    expect(publicUrlFor("a.txt")).toBe("https://cdn.test/a.txt");
    expect(getStorageStatus()).toMatchObject({ driver: "memory", prefix: "p/" });
    expect(await testStorage()).toEqual({ ok: true, driver: "memory" });

    await deleteFile("a.txt");
    expect(await fileExists("a.txt")).toBe(false);
  });

  it("builds the backend once, and again after settings change", async () => {
    setSetting("storage.driver", "memory");
    invalidateStorageCache();
    await fileExists("x");
    await fileExists("y");
    expect(created).toBe(1);
    invalidateStorageCache();
    await fileExists("x");
    expect(created).toBe(2);
  });

  it("refuses to fall back to local disk when the driver is missing", async () => {
    setSetting("storage.driver", "gone");
    invalidateStorageCache();
    await expect(writeFile("a", new Uint8Array([1]))).rejects.toThrow(/storage driver 'gone' is not registered/);
    expect(getStorageStatus().driver).toBe("gone");
  });

  it("lists drivers and refuses duplicates", () => {
    expect(listStorageDrivers()).toEqual([
      { name: "local", builtin: true }, { name: "s3", builtin: true }, { name: "memory", builtin: false },
    ]);
    expect(() => registerStorageDriver({ name: "s3", create: () => { throw new Error(); } })).toThrow(/already registered/);
  });
});
