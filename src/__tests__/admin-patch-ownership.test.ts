/**
 * `PATCH /admin/admins/:id` let any admin overwrite another admin's email and
 * password (Shannon AUTHZ-01): a silent takeover of that admin's sign-in, with
 * everything they do afterwards attributed to them. DELETE already refused to
 * act on the caller's own row; PATCH now only acts on it.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { makeAdminsPlugin } from "../api/admins.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-admin-patch";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  const hash = await Bun.password.hash("original-pw-1234");
  await getDb().insert(admin).values([
    { id: "a1", email: "one@test.local", password_hash: hash, password_reset_at: 0, created_at: 0 },
    { id: "a2", email: "two@test.local", password_hash: hash, password_reset_at: 0, created_at: 0 },
  ]);
});

afterEach(() => closeDb());

async function as(id: string): Promise<string> {
  return (await signAuthToken({ payload: { id, email: `${id}@x` }, audience: "admin", expiresInSeconds: 3600, jwtSecret: SECRET })).token;
}

const patch = async (target: string, body: unknown, actor: string) =>
  makeAdminsPlugin(SECRET).handle(new Request(`http://localhost/admin/admins/${target}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${await as(actor)}` },
    body: JSON.stringify(body),
  }));

describe("PATCH /admin/admins/:id", () => {
  it("refuses to change another admin's password or email", async () => {
    expect((await patch("a2", { password: "attacker-chosen-pw-1" }, "a1")).status).toBe(403);
    expect((await patch("a2", { email: "attacker@test.local" }, "a1")).status).toBe(403);
    const row = (await getDb().select().from(admin).where(eq(admin.id, "a2")))[0]!;
    expect(row.email).toBe("two@test.local");
    expect(await Bun.password.verify("original-pw-1234", row.password_hash)).toBe(true);
  });

  it("still lets an admin change their own (legitimate path)", async () => {
    expect((await patch("a1", { email: "new-one@test.local", password: "my-new-pw-12345" }, "a1")).status).toBe(200);
    const row = (await getDb().select().from(admin).where(eq(admin.id, "a1")))[0]!;
    expect(row.email).toBe("new-one@test.local");
  });
});
