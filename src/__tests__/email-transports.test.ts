/**
 * Email transports an extension registers: selected by `email.transport`,
 * used by every sender (auth emails, hook helpers), with the shared From
 * address.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import {
  EmailNotConfiguredError, invalidateEmailCache, isEmailConfigured, listEmailTransports,
  registerEmailTransport, sendEmail, sendMailRich, verifySmtp, type EmailMessage,
} from "../core/email.ts";
import { createCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";

const sent: EmailMessage[] = [];
let off: () => void;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  sent.length = 0;
  off = registerEmailTransport({
    name: "outbox",
    isConfigured: (s) => s["email.outbox.key"] === "k",
    async send(m) { sent.push(m); return { messageId: `m${sent.length}` }; },
    async verify(s) { if (s["email.outbox.key"] !== "k") throw new Error("bad key"); },
  });
  invalidateEmailCache();
});

afterEach(() => {
  off();
  closeDb();
});

function useOutbox(): void {
  setSetting("email.transport", "outbox");
  setSetting("email.outbox.key", "k");
  setSetting("smtp.from", "noreply@app.test");
}

describe("registered email transports", () => {
  it("is configured only when the transport says so and a From address is set", () => {
    setSetting("email.transport", "outbox");
    expect(isEmailConfigured()).toBe(false);
    setSetting("email.outbox.key", "k");
    expect(isEmailConfigured()).toBe(false);
    setSetting("smtp.from", "noreply@app.test");
    expect(isEmailConfigured()).toBe(true);
  });

  it("sends plain and rich mail with the From address filled in", async () => {
    useOutbox();
    expect(await sendEmail({ to: "a@x.test", subject: "Hi", text: "body" })).toEqual({ messageId: "m1" });
    await sendMailRich({ to: "b@x.test", subject: "Hi", html: "<b>x</b>", from: "team@app.test", cc: "c@x.test" });
    expect(sent.map((m) => [m.to, m.from])).toEqual([["a@x.test", "noreply@app.test"], ["b@x.test", "team@app.test"]]);
    expect(sent[1]!.cc).toBe("c@x.test");
    expect(await verifySmtp()).toEqual({ ok: true });
  });

  it("refuses to send while the transport isn't configured", async () => {
    setSetting("email.transport", "outbox");
    setSetting("smtp.from", "noreply@app.test");
    await expect(sendEmail({ to: "a@x.test", subject: "Hi", text: "b" })).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect((await verifySmtp()).ok).toBe(false);
  });

  it("carries the sign-up verification email", async () => {
    useOutbox();
    await createCollection({ name: "users", type: "auth", create_rule: null, fields: JSON.stringify([]), view_rule: null });
    const res = await makeAuthPlugin("test-secret-email-transports").handle(new Request("http://localhost/auth/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@x.test", password: "a-long-enough-password" }),
    }));
    expect(res.status).toBe(200);
    for (let i = 0; i < 20 && sent.length === 0; i++) await Bun.sleep(10);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("new@x.test");
  });

  it("lists transports and refuses duplicates", () => {
    expect(listEmailTransports()).toEqual([{ name: "smtp", builtin: true }, { name: "outbox", builtin: false }]);
    expect(() => registerEmailTransport({ name: "smtp", isConfigured: () => true, send: async () => ({ messageId: "" }) })).toThrow(/already registered/);
  });
});
