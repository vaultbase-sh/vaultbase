/**
 * First-admin setup (handoff #12): `POST /admin/setup` was open unless
 * VAULTBASE_SETUP_KEY was set, so whoever reached a fresh install first —
 * container image, manual binary, `bun src/index.ts` — became its admin.
 * The server now generates a setup key when none is configured, keeps it in
 * the data dir (0600) and prints it, and setup requires it.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { admin } from "../db/schema.ts";
import { configureSetupKey, requiredSetupKey } from "../core/setup-key.ts";

const SECRET = "test-setup-key";
let dir: string;
const savedEnv = process.env["VAULTBASE_SETUP_KEY"];

beforeEach(async () => {
  delete process.env["VAULTBASE_SETUP_KEY"];
  dir = mkdtempSync(join(tmpdir(), "vb-setup-key-"));
  configureSetupKey(dir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  configureSetupKey(null);
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env["VAULTBASE_SETUP_KEY"];
  else process.env["VAULTBASE_SETUP_KEY"] = savedEnv;
});

function setup(body: Record<string, unknown>, key?: string): Promise<Response> {
  return makeAuthPlugin(SECRET).handle(new Request("http://localhost/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-setup-key": key } : {}) },
    body: JSON.stringify({ email: "admin@example.com", password: "super-strong-password", ...body }),
  }));
}

const adminCount = async () => (await getDb().select().from(admin)).length;

describe("first-admin setup needs a key", () => {
  it("refuses setup without a key on a fresh install, even with no VAULTBASE_SETUP_KEY", async () => {
    const res = await setup({});
    expect(res.status).toBe(401);
    expect(await adminCount()).toBe(0);
  });

  it("refuses a wrong key", async () => {
    requiredSetupKey({ quiet: true });
    expect((await setup({}, "not-the-key")).status).toBe(401);
    expect((await setup({ setup_key: "not-the-key" })).status).toBe(401);
    expect(await adminCount()).toBe(0);
  });

  it("the generated key works as a header (legitimate path) and is then removed", async () => {
    const key = requiredSetupKey({ quiet: true });
    const file = join(dir, ".setup-key");
    expect(readFileSync(file, "utf8")).toBe(key);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const res = await setup({}, key);
    expect(res.status).toBe(200);
    expect(await adminCount()).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("the key works in the body, for the browser setup page", async () => {
    const key = requiredSetupKey({ quiet: true });
    expect((await setup({ setup_key: key })).status).toBe(200);
  });

  it("the key survives a restart (same data dir, new process state)", async () => {
    const key = requiredSetupKey({ quiet: true });
    configureSetupKey(dir);
    expect(requiredSetupKey({ quiet: true })).toBe(key);
  });

  it("VAULTBASE_SETUP_KEY takes precedence over a generated key", async () => {
    const generated = requiredSetupKey({ quiet: true });
    process.env["VAULTBASE_SETUP_KEY"] = "operator-chosen-key";
    expect((await setup({}, generated)).status).toBe(401);
    expect((await setup({}, "operator-chosen-key")).status).toBe(200);
  });

  it("status tells the setup page a key is required", async () => {
    const res = await makeAuthPlugin(SECRET).handle(new Request("http://localhost/admin/setup/status"));
    const body = await res.json() as { data: { has_admin: boolean; key_required: boolean } };
    expect(body.data).toEqual({ has_admin: false, key_required: true });
  });
});

describe("setup-admin reads the service env file", () => {
  it("loads unset variables from the file and keeps ones already set", async () => {
    const { loadServiceEnvFile } = await import("../config.ts");
    const { writeFileSync } = await import("fs");
    const file = join(dir, "vaultbase.env");
    writeFileSync(file, `# comment\nVB_TEST_DATA_DIR=/var/lib/vaultbase\nexport VB_TEST_QUOTED="a b"\nVB_TEST_KEPT=from-file\n`);
    process.env["VB_TEST_KEPT"] = "from-env";
    try {
      expect(loadServiceEnvFile(file)).toBe(file);
      expect(process.env["VB_TEST_DATA_DIR"]).toBe("/var/lib/vaultbase");
      expect(process.env["VB_TEST_QUOTED"]).toBe("a b");
      expect(process.env["VB_TEST_KEPT"]).toBe("from-env");
      expect(loadServiceEnvFile(join(dir, "missing.env"))).toBeNull();
    } finally {
      for (const k of ["VB_TEST_DATA_DIR", "VB_TEST_QUOTED", "VB_TEST_KEPT"]) delete process.env[k];
    }
  });
});

describe("setup key across processes (review 15 F-7)", () => {
  it("an empty key file left by a crash is replaced, not ignored", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(join(dir, ".setup-key"), "");
    const key = requiredSetupKey({ quiet: true });
    expect(key.length).toBeGreaterThan(10);
    expect(readFileSync(join(dir, ".setup-key"), "utf8")).toBe(key);
    configureSetupKey(dir);
    expect(requiredSetupKey({ quiet: true })).toBe(key);
  });

  it("workers starting together all end up with the same key", async () => {
    const mod = new URL("../core/setup-key.ts", import.meta.url).pathname;
    const script = `
      const { configureSetupKey, requiredSetupKey } = await import(${JSON.stringify(mod)});
      configureSetupKey(${JSON.stringify(dir)});
      process.stdout.write(requiredSetupKey({ quiet: true }));
    `;
    const env: Record<string, string | undefined> = { ...process.env, BUN_BE_BUN: "1" };
    delete env["VAULTBASE_SETUP_KEY"];
    const procs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", env }));
    const keys = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(readFileSync(join(dir, ".setup-key"), "utf8"));
    const { readdirSync } = await import("fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
