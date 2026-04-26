import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { ValidationError, validateRecord } from "../core/validate.ts";
import type { Collection } from "../db/schema.ts";
import type { FieldDef } from "../core/collections.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

function makeCol(fields: FieldDef[]): Collection {
  return {
    id: "test_col",
    name: "test",
    fields: JSON.stringify(fields),
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    created_at: 0, updated_at: 0,
  };
}

describe("validateRecord — defensive against null/undefined", () => {
  it("treats undefined data as empty object", async () => {
    const col = makeCol([{ name: "title", type: "text", required: false }]);
    await expect(validateRecord(col, undefined, "create")).resolves.toBeUndefined();
  });

  it("treats null data as empty object", async () => {
    const col = makeCol([{ name: "title", type: "text", required: false }]);
    await expect(validateRecord(col, null, "create")).resolves.toBeUndefined();
  });

  it("undefined data on create with required field still fails", async () => {
    const col = makeCol([{ name: "title", type: "text", required: true }]);
    await expect(validateRecord(col, undefined, "create")).rejects.toThrow(ValidationError);
  });
});

describe("validateRecord — required fields", () => {
  it("rejects missing required field on create", async () => {
    const col = makeCol([{ name: "title", type: "text", required: true }]);
    try {
      await validateRecord(col, {}, "create");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).details).toHaveProperty("title");
    }
  });

  it("allows missing optional field", async () => {
    const col = makeCol([{ name: "title", type: "text", required: false }]);
    await expect(validateRecord(col, {}, "create")).resolves.toBeUndefined();
  });

  it("allows missing field on update", async () => {
    const col = makeCol([{ name: "title", type: "text", required: true }]);
    await expect(validateRecord(col, {}, "update")).resolves.toBeUndefined();
  });
});

describe("validateRecord — text constraints", () => {
  it("enforces min length", async () => {
    const col = makeCol([{ name: "title", type: "text", options: { min: 3 } }]);
    await expect(validateRecord(col, { title: "ab" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { title: "abc" }, "create")).resolves.toBeUndefined();
  });

  it("enforces max length", async () => {
    const col = makeCol([{ name: "title", type: "text", options: { max: 5 } }]);
    await expect(validateRecord(col, { title: "abcdef" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { title: "abcde" }, "create")).resolves.toBeUndefined();
  });

  it("enforces regex pattern", async () => {
    const col = makeCol([{ name: "slug", type: "text", options: { pattern: "^[a-z0-9-]+$" } }]);
    await expect(validateRecord(col, { slug: "hello world" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { slug: "hello-world" }, "create")).resolves.toBeUndefined();
  });
});

describe("validateRecord — number", () => {
  it("rejects non-numbers", async () => {
    const col = makeCol([{ name: "age", type: "number" }]);
    await expect(validateRecord(col, { age: "twenty" }, "create")).rejects.toThrow(ValidationError);
  });

  it("enforces min/max value", async () => {
    const col = makeCol([{ name: "age", type: "number", options: { min: 18, max: 65 } }]);
    await expect(validateRecord(col, { age: 17 }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { age: 66 }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { age: 30 }, "create")).resolves.toBeUndefined();
  });
});

describe("validateRecord — bool", () => {
  it("rejects non-boolean", async () => {
    const col = makeCol([{ name: "active", type: "bool" }]);
    await expect(validateRecord(col, { active: "yes" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { active: true }, "create")).resolves.toBeUndefined();
  });
});

describe("validateRecord — email", () => {
  it("rejects bad emails", async () => {
    const col = makeCol([{ name: "email", type: "email" }]);
    await expect(validateRecord(col, { email: "not-an-email" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { email: "user@" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { email: "user@example.com" }, "create")).resolves.toBeUndefined();
  });
});

describe("validateRecord — url", () => {
  it("rejects bad URLs", async () => {
    const col = makeCol([{ name: "site", type: "url" }]);
    await expect(validateRecord(col, { site: "example.com" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { site: "ftp://x.com" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { site: "https://example.com" }, "create")).resolves.toBeUndefined();
    await expect(validateRecord(col, { site: "http://example.com/path?q=1" }, "create")).resolves.toBeUndefined();
  });
});

describe("validateRecord — select", () => {
  it("rejects values not in allowed list", async () => {
    const col = makeCol([{ name: "status", type: "select", options: { values: ["draft", "live"] } }]);
    await expect(validateRecord(col, { status: "published" }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { status: "draft" }, "create")).resolves.toBeUndefined();
  });

  it("multiple: validates each value", async () => {
    const col = makeCol([{ name: "tags", type: "select", options: { values: ["a", "b", "c"], multiple: true } }]);
    await expect(validateRecord(col, { tags: ["a", "x"] }, "create")).rejects.toThrow(ValidationError);
    await expect(validateRecord(col, { tags: ["a", "b"] }, "create")).resolves.toBeUndefined();
  });

  it("rejects any value when select has no allowed values configured", async () => {
    const col = makeCol([{ name: "status", type: "select" }]);
    await expect(validateRecord(col, { status: "anything" }, "create")).rejects.toThrow(ValidationError);
  });
});

describe("validateRecord — collects multiple errors", () => {
  it("reports all errors at once", async () => {
    const col = makeCol([
      { name: "title", type: "text", required: true },
      { name: "age",   type: "number", options: { min: 18 } },
    ]);
    try {
      await validateRecord(col, { age: 5 }, "create");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const details = (e as ValidationError).details;
      expect(details).toHaveProperty("title");
      expect(details).toHaveProperty("age");
    }
  });
});
