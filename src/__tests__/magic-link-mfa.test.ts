/**
 * The hosted magic-link page posted the link's token to `/otp/auth`, which
 * spends it. For an account with TOTP on, the answer is an MFA ticket rather
 * than a session, and the page only knew how to show a session — so the user
 * saw "Invalid or expired link" with the link already burned. The page now
 * finishes the sign-in with the second factor; this checks the page wires
 * that up and that the API flow it drives works end to end.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { authTokens } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { makeAuthPagesPlugin } from "../admin/auth-pages.ts";
import { ensureAuthCollection, hashedTokenId } from "./_helpers.ts";
import { insertUser } from "../core/users-table.ts";
import { generateCode, generateSecret } from "../core/totp.ts";

const SECRET = "test-secret-magic-link-mfa";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  setSetting("auth.otp.enabled", "1");
});

afterEach(() => closeDb());

describe("magic-link page for an MFA account", () => {
  it("handles the MFA ticket instead of dead-ending", async () => {
    const res = await makeAuthPagesPlugin().handle(new Request("http://localhost/auth/otp?token=abc&collection=users"));
    const html = await res.text();
    expect(html).toContain("mfa_required");
    expect(html).toContain("/login/mfa");
    expect(html).toContain('id="code"');
  });

  it("the link's ticket can be finished with a TOTP code (the flow the page drives)", async () => {
    const col = await ensureAuthCollection("users");
    const id = crypto.randomUUID();
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    await insertUser(col, { id, email: "m@test.local", password_hash: "x", totp_secret: secret, totp_enabled: 1, email_verified: 1, created_at: now, updated_at: now });
    const link = "a".repeat(64);
    await getDb().insert(authTokens).values({ id: hashedTokenId(link), user_id: id, collection_id: col.id, purpose: "otp", code: "123456", expires_at: now + 600 });
    const app = makeAuthPlugin(SECRET);
    const post = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const first = await (await post("/auth/users/otp/auth", { token: link })).json() as { data: { mfa_required: boolean; mfa_token: string } };
    expect(first.data.mfa_required).toBe(true);
    const done = await post("/auth/users/login/mfa", { mfa_token: first.data.mfa_token, code: generateCode(secret) });
    expect(done.status).toBe(200);
  });
});
