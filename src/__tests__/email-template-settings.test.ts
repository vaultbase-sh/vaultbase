/**
 * Every email template reads its own subject and body settings, falling back
 * to the default when a setting is empty. The admin now edits all five
 * (verify, reset, email change, invite, sign-in code); before, only the
 * first two had an editor.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { DEFAULT_TEMPLATES, getTemplate, renderTemplate, type TemplateKind } from "../core/email.ts";

beforeEach(async () => { await initDb(":memory:"); await runMigrations(); });
afterEach(async () => { await closeDb(); });

describe("email template settings", () => {
  for (const kind of Object.keys(DEFAULT_TEMPLATES) as TemplateKind[]) {
    // Awaited: the row is written after the in-memory value, and on Postgres
    // an unawaited write can land after the test's schema is dropped.
    it(`${kind}: uses its own settings, and the default when empty`, async () => {
      expect(getTemplate(kind)).toEqual({ ...DEFAULT_TEMPLATES[kind] });
      await setSetting(`email.${kind}.subject`, `Custom ${kind}`);
      await setSetting(`email.${kind}.body`, `Body for {{email}} at {{link}}`);
      const t = getTemplate(kind);
      expect(t.subject).toBe(`Custom ${kind}`);
      expect(renderTemplate(t.body, { email: "a@x", link: "https://l" })).toBe("Body for a@x at https://l");
      await setSetting(`email.${kind}.subject`, "   ");
      expect(getTemplate(kind).subject).toBe(DEFAULT_TEMPLATES[kind].subject);
    });
  }
});
