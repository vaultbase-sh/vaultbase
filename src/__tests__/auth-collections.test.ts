import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  AUTH_IMPLICIT_FIELDS,
  AUTH_IMPLICIT_FIELD_NAMES,
  AUTH_RESERVED_FIELD_NAMES,
  CollectionValidationError,
  createCollection,
  getCollection,
  parseFields,
  updateCollection,
} from "../core/collections.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

describe("collection type column", () => {
  it("defaults to 'base' when not specified", async () => {
    const col = await createCollection({ name: "posts", fields: JSON.stringify([]) });
    expect(col.type).toBe("base");
  });

  it("persists 'auth' type when specified", async () => {
    const col = await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    expect(col.type).toBe("auth");
    const fetched = await getCollection("users");
    expect(fetched?.type).toBe("auth");
  });
});

describe("reserved field name enforcement", () => {
  it.each(AUTH_RESERVED_FIELD_NAMES.map((n) => [n]))(
    "rejects '%s' on auth collections at create time",
    async (reservedName) => {
      await expect(
        createCollection({
          name: "users",
          type: "auth",
          fields: JSON.stringify([{ name: reservedName, type: "text" }]),
        })
      ).rejects.toThrow(CollectionValidationError);
    }
  );

  it("allows 'email' on a base collection", async () => {
    await expect(
      createCollection({
        name: "contacts",
        type: "base",
        fields: JSON.stringify([{ name: "email", type: "text" }]),
      })
    ).resolves.toBeDefined();
  });

  it("rejects adding a reserved-name field via update on auth collection", async () => {
    const col = await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([{ name: "name", type: "text" }]),
    });
    await expect(
      updateCollection(col.id, {
        fields: JSON.stringify([
          { name: "name", type: "text" },
          { name: "verified", type: "bool" },
        ]),
      })
    ).rejects.toThrow(CollectionValidationError);
  });

  it("allows email/verified when marked implicit on auth collections", async () => {
    await expect(
      createCollection({
        name: "users",
        type: "auth",
        fields: JSON.stringify([
          { name: "email",    type: "email", required: true, implicit: true, options: { unique: true } },
          { name: "verified", type: "bool",  implicit: true },
        ]),
      })
    ).resolves.toBeDefined();
  });

  it("error details include all clashing field names", async () => {
    try {
      await createCollection({
        name: "users",
        type: "auth",
        fields: JSON.stringify([
          { name: "email",    type: "text" },
          { name: "password", type: "text" },
          { name: "username", type: "text" },
        ]),
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CollectionValidationError);
      const details = (e as CollectionValidationError).details;
      expect(details).toHaveProperty("email");
      expect(details).toHaveProperty("password");
      expect(details).not.toHaveProperty("username");
    }
  });
});

describe("implicit fields auto-injected on auth create", () => {
  it("seeds email + verified when caller omits them", async () => {
    const col = await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([{ name: "username", type: "text" }]),
    });
    const fields = parseFields(col.fields);
    const implicit = fields.filter((f) => f.implicit);
    expect(implicit.map((f) => f.name).sort()).toEqual([...AUTH_IMPLICIT_FIELD_NAMES].sort());
    // Implicit fields appear before user-defined ones
    expect(fields[0]?.name).toBe(AUTH_IMPLICIT_FIELDS[0]!.name);
  });

  it("preserves caller-provided implicit field options instead of overwriting", async () => {
    const col = await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([
        { name: "email", type: "email", required: true, implicit: true, options: { min: 5, unique: true } },
      ]),
    });
    const fields = parseFields(col.fields);
    const email = fields.find((f) => f.name === "email");
    expect(email?.options?.min).toBe(5);
  });

  it("base collections do NOT get implicit fields", async () => {
    const col = await createCollection({
      name: "posts",
      type: "base",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    const fields = parseFields(col.fields);
    expect(fields.find((f) => f.implicit)).toBeUndefined();
  });

  it("update preserves implicit fields if caller omits them", async () => {
    const col = await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([{ name: "username", type: "text" }]),
    });
    // Caller PATCHes with only their user fields, no implicit
    await updateCollection(col.id, {
      fields: JSON.stringify([{ name: "username", type: "text", required: true }]),
    });
    const after = await getCollection("users");
    const fields = parseFields(after!.fields);
    const implicit = fields.filter((f) => f.implicit);
    expect(implicit.length).toBe(AUTH_IMPLICIT_FIELDS.length);
  });

  it("update lets caller customize implicit field options", async () => {
    const col = await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([]),
    });
    await updateCollection(col.id, {
      fields: JSON.stringify([
        { name: "email", type: "email", required: true, implicit: true, options: { min: 6 } },
        { name: "verified", type: "bool", required: true, implicit: true },
      ]),
    });
    const after = await getCollection("users");
    const fields = parseFields(after!.fields);
    expect(fields.find((f) => f.name === "email")?.options?.min).toBe(6);
    expect(fields.find((f) => f.name === "verified")?.required).toBe(true);
  });
});
