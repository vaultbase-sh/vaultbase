/**
 * Rules could only see `@request.auth.id`, `.email` and `.type`, so the
 * usual "signed in" check, `@request.auth.id != ""`, also admitted
 * anonymous guest sessions and users of every auth collection, and nothing
 * could require a verified email. `@request.auth.collectionName`,
 * `.verified` and `.anonymous` are now available, in list queries and in
 * single-record checks alike.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-rule-auth-props";
let docId: string;

async function rule(r: string) {
  await createCollection({
    name: "docs", fields: JSON.stringify([{ name: "t", type: "text" }]),
    list_rule: r, view_rule: r,
  });
  docId = (await createRecord("docs", { t: "x" }, null)).id;
}

async function anonJwt(id: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({ id, email: "", collection: "users", anonymous: true })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("user")
    .setIssuedAt(now).setExpirationTime("1h").setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}

/** [list count, view status] for a token. */
async function access(token: string): Promise<[number, number]> {
  const h = { authorization: `Bearer ${token}` };
  const list = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/docs", { headers: h }));
  const view = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/docs/${docId}`, { headers: h }));
  return [((await list.json()) as { data: unknown[] }).data.length, view.status];
}

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

describe("@request.auth props", () => {
  it("anonymous: guests are told apart from accounts", async () => {
    await rule('@request.auth.id != "" && @request.auth.anonymous = false');
    const guest = await seedAuthUser({ collection: "users", email: "g@test.local", isAnonymous: true });
    const member = await seedAuthUser({ collection: "users", email: "m@test.local" });
    expect(await access(await anonJwt(guest))).toEqual([0, 403]);
    expect(await access(await signUserJwt(member, "m@test.local", "users", SECRET))).toEqual([1, 200]);
  });

  it("collectionName: users of another auth collection are refused", async () => {
    await rule('@request.auth.collectionName = "staff"');
    const staff = await seedAuthUser({ collection: "staff", email: "s@test.local" });
    const customer = await seedAuthUser({ collection: "users", email: "c@test.local" });
    expect(await access(await signUserJwt(customer, "c@test.local", "users", SECRET))).toEqual([0, 403]);
    expect(await access(await signUserJwt(staff, "s@test.local", "staff", SECRET))).toEqual([1, 200]);
  });

  it("verified: read from the account, not the token", async () => {
    await rule("@request.auth.verified = true");
    const unverified = await seedAuthUser({ collection: "users", email: "u@test.local" });
    const verified = await seedAuthUser({ collection: "users", email: "v@test.local", emailVerified: true });
    expect(await access(await signUserJwt(unverified, "u@test.local", "users", SECRET))).toEqual([0, 403]);
    expect(await access(await signUserJwt(verified, "v@test.local", "users", SECRET))).toEqual([1, 200]);
  });

  it("an anonymous caller (no token) passes none of them", async () => {
    await rule("@request.auth.anonymous = false");
    const list = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/docs"));
    expect(((await list.json()) as { data: unknown[] }).data.length).toBe(0);
  });
});
