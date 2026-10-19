/**
 * One stored value that won't decrypt (tampered, or written under another
 * key) used to fail the whole list with a bare WebCrypto 500. That field
 * reads as null; the other records and fields come back.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, getRecord, listRecords } from "../core/records.ts";

const ENC_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 bytes base64

beforeEach(async () => {
  process.env["VAULTBASE_ENCRYPTION_KEY"] = ENC_KEY;
  await initDb(":memory:");
  await runMigrations();
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); delete process.env["VAULTBASE_ENCRYPTION_KEY"]; });

describe("an encrypted value that won't decrypt", () => {
  it("reads as null without failing the list", async () => {
    await createCollection({ name: "vault", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "secret", type: "text", options: { encrypted: true } }]) });
    const good = await createRecord("vault", { title: "good", secret: "kept" });
    const bad = await createRecord("vault", { title: "bad", secret: "lost" });
    const row = await db.get<{ secret: string }>(`SELECT secret FROM vb_vault WHERE id = ?`, [bad.id]);
    // Flip the last character of the ciphertext.
    const s = row!.secret;
    await db.run(`UPDATE vb_vault SET secret = ? WHERE id = ?`, [s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.at(-1), bad.id]);

    const list = await listRecords("vault", { sort: "title" });
    const byTitle = Object.fromEntries(list.data.map((r) => [(r as unknown as { title: string }).title, r as unknown as { secret: unknown }]));
    expect(byTitle["good"]!.secret).toBe("kept");
    expect(byTitle["bad"]!.secret).toBeNull();
    expect(((await getRecord("vault", good.id)) as unknown as { secret: string }).secret).toBe("kept");
  });
});
