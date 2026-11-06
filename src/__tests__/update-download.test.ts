/**
 * `vaultbase update` downloaded the raw binary (~125 MB) even where the
 * release has a `.xz` (~50 MB) and `xz` is installed. It now takes the `.xz`
 * when it can, and falls back to the raw asset when the `.xz` is missing,
 * fails to download or doesn't decompress.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { fetchReleaseBinary } from "../scripts/update.ts";

const haveXz = spawnSync("xz", ["--version"]).status === 0;
const ARTIFACT = "vaultbase-linux-x64";

let src: string;
let server: ReturnType<typeof Bun.serve>;
let binary: Uint8Array;
let packed: Uint8Array;
const served: string[] = [];

beforeAll(() => {
  src = mkdtempSync(join(tmpdir(), "vb-update-dl-"));
  binary = new Uint8Array(256 * 1024).map((_, i) => (i * 31) % 251);
  writeFileSync(join(src, ARTIFACT), binary);
  if (haveXz) {
    spawnSync("xz", ["-k", "-f", join(src, ARTIFACT)]);
    packed = new Uint8Array(readFileSync(join(src, `${ARTIFACT}.xz`)));
  }
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      served.push(path);
      if (path === "/raw") return new Response(binary);
      if (path === "/xz") return new Response(packed);
      if (path === "/broken.xz") return new Response("not xz at all");
      return new Response("missing", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(src, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const download = async (u: string, dest: string) => {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  await Bun.write(dest, res);
};
const assets = (xzPath: string | null) => [
  { name: ARTIFACT, browser_download_url: url("/raw"), size: binary.length },
  ...(xzPath ? [{ name: `${ARTIFACT}.xz`, browser_download_url: url(xzPath), size: 0 }] : []),
];

async function fetchInto(xzPath: string | null, xz: boolean): Promise<{ used: string; bytes: Uint8Array; dir: string; log: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "vb-update-dl-out-"));
  const log: string[] = [];
  served.length = 0;
  const used = await fetchReleaseBinary(assets(xzPath), ARTIFACT, dir, (s) => log.push(s), { download, xz });
  return { used, bytes: new Uint8Array(readFileSync(join(dir, ARTIFACT))), dir, log };
}

describe("vaultbase update: which asset it downloads", () => {
  it.skipIf(!haveXz)("takes the .xz when the release has one and xz is installed", async () => {
    const r = await fetchInto("/xz", true);
    expect(r.used).toBe("xz");
    expect(r.bytes).toEqual(binary);
    expect(served).toEqual(["/xz"]);
    expect(existsSync(join(r.dir, `${ARTIFACT}.xz`))).toBe(false);
  });

  it("downloads the raw binary without xz", async () => {
    const r = await fetchInto("/xz", false);
    expect(r.used).toBe("raw");
    expect(r.bytes).toEqual(binary);
    expect(served).toEqual(["/raw"]);
  });

  it("downloads the raw binary from a release without a .xz", async () => {
    const r = await fetchInto(null, true);
    expect(r.used).toBe("raw");
    expect(served).toEqual(["/raw"]);
  });

  it.skipIf(!haveXz)("falls back to the raw binary when the .xz download fails", async () => {
    const r = await fetchInto("/gone.xz", true);
    expect(r.used).toBe("raw");
    expect(r.bytes).toEqual(binary);
    expect(r.log.join("\n")).toContain("downloading the raw binary");
  });

  it.skipIf(!haveXz)("falls back to the raw binary when the .xz doesn't decompress", async () => {
    const r = await fetchInto("/broken.xz", true);
    expect(r.used).toBe("raw");
    expect(r.bytes).toEqual(binary);
    expect(existsSync(join(r.dir, `${ARTIFACT}.xz`))).toBe(false);
  });
});
