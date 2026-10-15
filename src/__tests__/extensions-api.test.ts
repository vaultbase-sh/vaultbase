/**
 * GET /admin/extensions lists what's registered, for admins only.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { admin as adminTable } from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeExtensionsPlugin } from "../api/extensions.ts";
import { registerFieldType, registerRoute } from "../extend.ts";

const SECRET = "test-secret-extensions";
const offs: Array<() => void> = [];

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  for (const off of offs.splice(0)) off();
  await closeDb();
});

async function adminToken(): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(adminTable).values({
    id, email: "admin@x.test", password_hash: await Bun.password.hash("pw"), password_reset_at: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  return new jose.SignJWT({ id, email: "admin@x.test" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("admin")
    .setIssuedAt().setExpirationTime("1h").setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}

const get = (token?: string) => makeExtensionsPlugin(SECRET).handle(new Request("http://localhost/admin/extensions", {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

describe("GET /admin/extensions", () => {
  it("refuses non-admins", async () => {
    expect((await get()).status).toBe(401);
  });

  it("lists built-ins and what extensions registered", async () => {
    offs.push(registerFieldType({ type: "money" }));
    offs.push(registerRoute({ name: "ping", method: "GET", path: "/ping", handle: () => "pong" }));
    const res = await get(await adminToken());
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, Array<Record<string, unknown>>> };
    expect(data["fieldTypes"]!.find((t) => t["type"] === "money")).toMatchObject({ builtin: false });
    expect(data["storageDrivers"]!.map((d) => d["name"])).toContain("local");
    expect(data["emailTransports"]!.map((d) => d["name"])).toContain("smtp");
    expect(data["routes"]).toEqual([{ name: "ping", method: "GET", path: "/ping", requireAuth: false }]);
  });
});
