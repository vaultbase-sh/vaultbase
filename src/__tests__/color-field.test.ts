/**
 * `color` field type: a hex color stored as lowercase `#rrggbb` (or
 * `#rrggbbaa` with the `alpha` option). Short forms and any case are
 * accepted and normalised; anything else is a validation error.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-color-field";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({
    name: "themes",
    fields: JSON.stringify([
      { name: "accent", type: "color" },
      { name: "overlay", type: "color", options: { alpha: true } },
    ]),
  });
});

afterEach(() => closeDb());

const app = () => makeRecordsPlugin(SECRET);

async function create(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> | undefined; details: Record<string, string> | undefined }> {
  const res = await app().handle(new Request("http://localhost/themes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const json = await res.json() as { data?: Record<string, unknown>; details?: Record<string, string> };
  return { status: res.status, data: json.data, details: json.details };
}

describe("color field", () => {
  it("stores #rrggbb lowercase, expanding the short form", async () => {
    expect((await create({ accent: "#E85A4F" })).data?.["accent"]).toBe("#e85a4f");
    expect((await create({ accent: "#AbC" })).data?.["accent"]).toBe("#aabbcc");
  });

  it("rejects anything that isn't a hex color", async () => {
    for (const bad of ["red", "e85a4f", "#12345", "#ggg", "rgb(1,2,3)", 123]) {
      const r = await create({ accent: bad });
      expect(r.status).toBe(422);
      expect(r.details?.["accent"]).toContain("hex color");
    }
  });

  it("refuses an alpha channel unless the field allows it", async () => {
    expect((await create({ accent: "#e85a4f80" })).status).toBe(422);
    expect((await create({ overlay: "#E85A4F80" })).data?.["overlay"]).toBe("#e85a4f80");
    expect((await create({ overlay: "#0008" })).data?.["overlay"]).toBe("#00000088");
    expect((await create({ overlay: "#123456" })).data?.["overlay"]).toBe("#123456");
  });

  it("is optional unless required, and filterable", async () => {
    expect((await create({})).status).toBe(200);
    await create({ accent: "#ABC" });
    const res = await app().handle(new Request(`http://localhost/themes?filter=${encodeURIComponent('accent = "#aabbcc"')}`));
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

describe("unique color", () => {
  it("treats #ABC and #aabbcc as the same value", async () => {
    await createPublicCollection({ name: "brands", fields: JSON.stringify([{ name: "c", type: "color", options: { unique: true } }]) });
    const post = (c: string) => app().handle(new Request("http://localhost/brands", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c }),
    }));
    expect((await post("#aabbcc")).status).toBe(200);
    expect((await post("#ABC")).status).toBe(422);
  });
});
