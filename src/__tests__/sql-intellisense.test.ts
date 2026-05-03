/**
 * Frontend SQL helpers — tokenizer, context detector, alias resolver.
 *
 * These modules live under admin/src/sql/ but are pure TypeScript with
 * no Monaco / DOM dependencies, so they're testable here. Keeping the
 * tests next to the rest of the SQL test surface means the whole SQL
 * runner story (backend + frontend logic) lives in one suite.
 */
import { describe, expect, it } from "bun:test";
import {
  tokenize,
  meaningful,
  unquoteIdent,
} from "../sql/sql-tokenizer.ts";
import {
  analyzeContext,
  buildAliasMap,
} from "../sql/sql-context.ts";

describe("tokenizer", () => {
  it("splits a basic SELECT into idents + punct", () => {
    const t = meaningful(tokenize("SELECT id, name FROM users"));
    expect(t.map((x) => x.text)).toEqual(["SELECT", "id", ",", "name", "FROM", "users"]);
    expect(t[0]!.type).toBe("ident");
  });

  it("recognises strings + ignores keywords inside them", () => {
    const t = meaningful(tokenize("SELECT 'DROP TABLE x'"));
    expect(t.map((x) => x.type)).toEqual(["ident", "string"]);
  });

  it("handles -- line comments + /* block comments */", () => {
    const all = tokenize("-- comment\nSELECT 1 /* inline */ FROM t");
    expect(all.some((x) => x.type === "comment")).toBe(true);
    const m = meaningful(all);
    expect(m.map((x) => x.text)).toEqual(["SELECT", "1", "FROM", "t"]);
  });

  it("supports quoted + bracketed identifiers", () => {
    const t = meaningful(tokenize(`SELECT "long name", [also], \`foo\` FROM t`));
    expect(t[1]!.text).toBe('"long name"');
    expect(unquoteIdent('"long name"')).toBe("long name");
    expect(unquoteIdent('[also]')).toBe("also");
    expect(unquoteIdent('`foo`')).toBe("foo");
  });

  it("treats `''` as escaped quote inside strings", () => {
    const t = meaningful(tokenize("SELECT 'it''s ok'"));
    expect(t[1]!.type).toBe("string");
    expect(t[1]!.text).toBe("'it''s ok'");
  });
});

describe("analyzeContext", () => {
  function ctx(src: string, marker = "|"): ReturnType<typeof analyzeContext> {
    const offset = src.indexOf(marker);
    return analyzeContext({ src: src.replace(marker, ""), offset });
  }

  it("after FROM → expectTable", () => {
    expect(ctx("SELECT * FROM |").context.kind).toBe("expectTable");
    expect(ctx("SELECT * FROM us|").context.kind).toBe("expectTable");
  });

  it("after JOIN → expectTable", () => {
    expect(ctx("SELECT * FROM users u JOIN |").context.kind).toBe("expectTable");
  });

  it("after SELECT → expectColumn", () => {
    expect(ctx("SELECT |").context.kind).toBe("expectColumn");
    expect(ctx("SELECT id, |").context.kind).toBe("expectColumn");
  });

  it("after WHERE / ON / ORDER BY / GROUP BY → expectColumn", () => {
    expect(ctx("SELECT * FROM t WHERE |").context.kind).toBe("expectColumn");
    expect(ctx("SELECT * FROM a JOIN b ON |").context.kind).toBe("expectColumn");
    expect(ctx("SELECT * FROM t ORDER BY |").context.kind).toBe("expectColumn");
    expect(ctx("SELECT * FROM t GROUP BY |").context.kind).toBe("expectColumn");
  });

  it("after `<base>.` → afterDot with base name", () => {
    const c = ctx("SELECT u.| FROM users u").context;
    expect(c.kind).toBe("afterDot");
    if (c.kind === "afterDot") expect(c.base).toBe("u");
  });

  it("after quoted-ident dot → afterDot with unquoted base", () => {
    const c = ctx('SELECT "long name".| FROM "long name"').context;
    expect(c.kind).toBe("afterDot");
    if (c.kind === "afterDot") expect(c.base).toBe("long name");
  });

  it("plain SELECT (no clause keyword nearby) → expectAny", () => {
    expect(ctx("|").context.kind).toBe("expectAny");
  });

  it("returns the typed prefix when cursor is mid-word", () => {
    const r = ctx("SELECT * FROM us|");
    expect(r.prefix).toBe("us");
  });
});

describe("buildAliasMap", () => {
  it("maps bare alias", () => {
    const m = buildAliasMap("SELECT * FROM users u WHERE u.id = 1");
    expect(m.get("u")).toBe("users");
    expect(m.get("users")).toBe("users");
  });

  it("maps AS alias", () => {
    const m = buildAliasMap("SELECT * FROM users AS u JOIN posts AS p ON p.author_id = u.id");
    expect(m.get("u")).toBe("users");
    expect(m.get("p")).toBe("posts");
  });

  it("multi-table FROM", () => {
    const m = buildAliasMap("SELECT * FROM users u, orders o");
    expect(m.get("u")).toBe("users");
    expect(m.get("o")).toBe("orders");
  });

  it("does not treat clause keywords as aliases", () => {
    const m = buildAliasMap("SELECT * FROM users WHERE id = 1");
    // "WHERE" should not become an alias for users.
    expect(m.has("WHERE")).toBe(false);
    expect(m.has("where")).toBe(false);
    expect(m.get("users")).toBe("users");
  });

  it("handles quoted table names + bare alias", () => {
    const m = buildAliasMap('SELECT * FROM "long name" ln WHERE ln.id = 1');
    expect(m.get("ln")).toBe("long name");
    expect(m.get("long name")).toBe("long name");
  });

  it("UPDATE / INTO patterns", () => {
    const m = buildAliasMap("UPDATE users SET active = 1 WHERE id = 1");
    expect(m.get("users")).toBe("users");
    const m2 = buildAliasMap("INSERT INTO orders (id, total) VALUES (1, 100)");
    expect(m2.get("orders")).toBe("orders");
  });
});
