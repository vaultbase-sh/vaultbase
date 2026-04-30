/**
 * Regression test for N-6a: when a collection has encrypted-at-rest fields
 * AND history_enabled = 1, the history snapshot row must NOT contain the
 * decrypted plaintext. The values must be re-encrypted before persistence.
 *
 * On read (listRecordHistory / getHistoryAt), the values should round-trip
 * back to plaintext for the API consumer — so end-to-end the API still
 * shows the right value, but a DB-level inspection of `vaultbase_record_history`
 * confirms the data is encrypted at rest.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, updateRecord } from "../core/records.ts";
import { listRecordHistory } from "../core/record-history.ts";
import { recordHistory } from "../db/schema.ts";
import { isEncrypted } from "../core/encryption.ts";

const ENC_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 bytes base64

beforeEach(async () => {
  process.env["VAULTBASE_ENCRYPTION_KEY"] = ENC_KEY;
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env["VAULTBASE_ENCRYPTION_KEY"];
});

const FIELDS = [
  { name: "title", type: "text" },
  { name: "secret", type: "text", options: { encrypted: true } },
];

async function withHistoryAndEncryption() {
  const c = await createCollection({ name: "notes", fields: JSON.stringify(FIELDS) });
  await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
}

describe("N-6a: encrypted-field values are encrypted at rest in history rows", () => {
  it("persists encrypted ciphertext in vaultbase_record_history.snapshot", async () => {
    await withHistoryAndEncryption();
    const r = await createRecord("notes", { title: "hi", secret: "very-private" }, null);

    // Read the raw history row (no decryption layer).
    const rows = await getDb().select().from(recordHistory);
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0]!.snapshot) as Record<string, unknown>;

    // `secret` must be a vbenc:1:... string, NOT plaintext.
    expect(typeof stored["secret"]).toBe("string");
    expect(isEncrypted(stored["secret"] as string)).toBe(true);
    expect(stored["secret"]).not.toBe("very-private");

    // Non-encrypted fields stay plaintext.
    expect(stored["title"]).toBe("hi");
    expect(stored["id"]).toBe(r.id);
  });

  it("listRecordHistory decrypts snapshots back to plaintext for API consumers", async () => {
    await withHistoryAndEncryption();
    const r = await createRecord("notes", { title: "hi", secret: "very-private" }, null);
    await updateRecord("notes", r.id, { secret: "still-private" }, null);

    const list = await listRecordHistory("notes", r.id);
    expect(list.totalItems).toBe(2);
    const seen = list.data.map((e) => e.snapshot["secret"]);
    expect(seen).toContain("very-private");
    expect(seen).toContain("still-private");
  });

  it("preserves the live record's plaintext API shape (no regression)", async () => {
    await withHistoryAndEncryption();
    const r = await createRecord("notes", { title: "x", secret: "shh" }, null);
    expect(r["secret"]).toBe("shh");
  });
});
