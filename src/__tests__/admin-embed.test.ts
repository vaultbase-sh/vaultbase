import { describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const ADMIN_INDEX = join(import.meta.dir, "../admin/index.ts");
const HAS_DIST = existsSync(join(import.meta.dir, "../../admin/dist/index.html"));

// The embed macro returns one large object literal. If it is bound to a plain
// const, the minifier inlines a full copy at every reference, which tripled the
// admin payload in release binaries (~12 MB of duplicates).
describe("admin embed", () => {
  it.skipIf(!HAS_DIST)("inlines the embedded admin map exactly once", async () => {
    const out = await Bun.build({
      entrypoints: [ADMIN_INDEX],
      target: "bun",
      minify: true,
      external: ["elysia"],
    });
    expect(out.success).toBe(true);
    const code = await out.outputs[0]!.text();
    const copies = code.split('"index.html":').length - 1;
    expect(copies).toBe(1);
  }, 60_000);
});
