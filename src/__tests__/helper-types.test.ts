/**
 * The declarations in core/helper-types.ts are what the admin's editor and
 * a hooks folder's vaultbase.d.ts show for `ctx.helpers`. They are text, so
 * nothing but this test ties them to the helpers the server builds: the
 * editor used to know nothing of helpers.sql, flags, webhooks or notify.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ts from "typescript";
import { HELPER_TYPES } from "../core/helper-types.ts";
import { makeHookHelpers } from "../core/hooks.ts";
import { CODE_FILE_TYPES, _resetCodeFiles, startCodeFiles } from "../core/code-files.ts";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";

/** Member names of an interface, and of each member written as `{ ... }`. */
function declared(name: string): Record<string, string[] | null> {
  const file = ts.createSourceFile("helpers.d.ts", HELPER_TYPES, ts.ScriptTarget.ES2022, true);
  const out: Record<string, string[] | null> = {};
  const names = (members: ts.NodeArray<ts.TypeElement>) => members.map((m) => (m.name as ts.Identifier).text);
  for (const node of file.statements) {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== name) continue;
    for (const m of node.members) {
      const key = (m.name as ts.Identifier).text;
      out[key] = ts.isPropertySignature(m) && m.type && ts.isTypeLiteralNode(m.type) ? names(m.type.members).sort() : null;
    }
  }
  return out;
}

describe("helper type declarations", () => {
  it("parse as TypeScript", () => {
    const file = ts.createSourceFile("helpers.d.ts", HELPER_TYPES, ts.ScriptTarget.ES2022, true) as ts.SourceFile & { parseDiagnostics?: unknown[] };
    expect(file.parseDiagnostics ?? []).toEqual([]);
  });

  it("declare every helper the server builds, and nothing else", () => {
    const real: Record<string, string[] | null> = {};
    for (const [k, v] of Object.entries(makeHookHelpers({ name: "t" }))) {
      real[k] = typeof v === "function" ? null : Object.keys(v as object).sort();
    }
    expect(declared("HookHelpers")).toEqual(real);
  });

  it("declare the auth context's fields", () => {
    expect(Object.keys(declared("AuthContext")).sort()).toEqual(["anonymous", "collection", "email", "id", "type", "verified"]);
  });
});

/** Type-check `source` as a file in a hooks folder holding vaultbase.d.ts. */
function check(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "vb-types-"));
  try {
    writeFileSync(join(dir, "vaultbase.d.ts"), CODE_FILE_TYPES);
    writeFileSync(join(dir, "file.ts"), source);
    const program = ts.createProgram([join(dir, "vaultbase.d.ts"), join(dir, "file.ts")], {
      noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [],
    });
    return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("vaultbase.d.ts in a hooks folder", () => {
  it("types helpers, the route context and the auth context", () => {
    expect(check(`
import { defineHook, defineRoute, type Helpers, type Auth } from "vaultbase";
export const route = defineRoute({
  method: "POST", path: "/pay/:id",
  async handle(ctx) {
    const ip: string | null = ctx.ip;
    const who: Auth | null = ctx.auth;
    const total = await ctx.helpers.sql.transaction(async () => {
      await ctx.helpers.sql.exec("UPDATE vb_ledger SET n = n + 1 WHERE id = ?", [ctx.params.id]);
      const row = await ctx.helpers.sql.queryOne<{ n: number }>("SELECT n FROM vb_ledger WHERE id = ?", [ctx.params.id]);
      return row?.n ?? 0;
    });
    const on: boolean = await ctx.helpers.flags.isEnabled("beta", { user: who?.id });
    await ctx.helpers.records.update("posts", ctx.params.id!, { total });
    ctx.helpers.log(ip, on, who?.collection, who?.verified);
    return { total };
  },
});
export const hook = defineHook({ collection: "posts", event: "beforeCreate", run(ctx) { ctx.record.slug = ctx.helpers.slug(ctx.record.title); } });
export function later(h: Helpers) { return h.enqueue("mail", { to: "a" }, { delay: 5 }); }
`)).toEqual([]);
  });

  it("reports a helper that doesn't exist", () => {
    const errors = check(`
import { defineRoute } from "vaultbase";
export default defineRoute({ path: "/x", handle: (ctx) => ctx.helpers.sql.run("SELECT 1") });
`);
    expect(errors.join("\n")).toContain("Property 'run' does not exist");
  });

  it("is written on start, brought up to date when Vaultbase wrote it, and left alone when someone else did", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-types-dir-"));
    const file = join(dir, "vaultbase.d.ts");
    await initDb(":memory:");
    await runMigrations();
    try {
      await startCodeFiles(dir, { pollMs: 0 });
      expect(readFileSync(file, "utf8")).toBe(CODE_FILE_TYPES);

      // What 0.44 and earlier wrote.
      writeFileSync(file, `// Types for hook files. Written by Vaultbase; safe to commit, regenerated if deleted.\ndeclare module "vaultbase" { export type Helpers = Record<string, any>; }\n`);
      await startCodeFiles(dir, { pollMs: 0 });
      expect(readFileSync(file, "utf8")).toBe(CODE_FILE_TYPES);

      writeFileSync(file, `declare module "vaultbase" { export type Helpers = { mine: true }; }\n`);
      await startCodeFiles(dir, { pollMs: 0 });
      expect(readFileSync(file, "utf8")).toContain("mine: true");
    } finally {
      _resetCodeFiles();
      await closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
