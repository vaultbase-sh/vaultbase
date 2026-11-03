import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLogs, setLogsDir, _logReaderStats } from "../core/file-logger.ts";
import { normalizeReleaseTag, releaseIdentityRegexp } from "../scripts/update.ts";

// Run-4 audit: the log reader's cold read of a large day file loaded and
// parsed the whole file before trimming to the cache cap, and `vaultbase
// update` put an unchecked --version / tag_name into URLs and the cosign
// identity regexp.

/** MAX_CACHED_BYTES_PER_FILE in file-logger.ts. */
const CAP = 16 * 1024 * 1024;

let dir: string;
const file = () => join(dir, "2026-11-03.jsonl");
const pad = "x".repeat(1000);
const line = (i: number, extra = pad) => JSON.stringify({ id: `e${i}`, method: "GET", path: `/p/${i}/${extra}`, status: 200 }) + "\n";

describe("log reader tail read", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vb-run4-logs-"));
    setLogsDir(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses only the newest cap's worth of a large file on the first read", async () => {
    const n = 24_000; // ~25 MB, well past the 16 MiB cap
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(line(i));
    const body = parts.join("");
    expect(Buffer.byteLength(body)).toBeGreaterThan(CAP + 4 * 1024 * 1024);
    writeFileSync(file(), body);

    const before = _logReaderStats().parsedLines;
    const out = await readLogs({ limit: 50_000 });
    const parsed = _logReaderStats().parsedLines - before;
    const lineLen = line(0).length;
    // Only lines inside the tail window were parsed, not all n.
    expect(parsed).toBeLessThanOrEqual(Math.ceil(CAP / lineLen) + 1);
    expect(parsed).toBeLessThan(n);
    // Newest first, contiguous, no fragment of the line cut by the window.
    expect(out[0]?.id).toBe(`e${n - 1}`);
    const ids = out.map((e) => Number(String(e.id).slice(1)));
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1]! - 1);
    expect(out.length).toBe(parsed);
  });

  it("keeps the byte offset exact so the next read parses only appended lines", async () => {
    // Multi-byte characters, so a window cut can land inside a UTF-8 sequence.
    const wide = "é漢🙂".repeat(250);
    const parts: string[] = [];
    for (let i = 0; i < 12_000; i++) parts.push(line(i, wide));
    writeFileSync(file(), parts.join(""));
    await readLogs({ limit: 50_000 });

    const before = _logReaderStats().parsedLines;
    appendFileSync(file(), line(12_000, wide) + line(12_001, wide));
    const out = await readLogs({ limit: 50_000 });
    expect(_logReaderStats().parsedLines - before).toBe(2);
    expect(out[0]?.id).toBe("e12001");
    expect(out[1]?.id).toBe("e12000");
    expect(out[2]?.id).toBe("e11999");
    expect(String(out[0]?.path)).toContain(wide);
  });

  it("small files are still read whole", async () => {
    writeFileSync(file(), line(1) + line(2) + line(3));
    const out = await readLogs({ limit: 10 });
    expect(out.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
  });

  it("a large append to a warm cache is also read from its tail", async () => {
    writeFileSync(file(), line(0));
    await readLogs({ limit: 10 });
    const parts: string[] = [];
    for (let i = 1; i <= 20_000; i++) parts.push(line(i));
    appendFileSync(file(), parts.join(""));
    const before = _logReaderStats().parsedLines;
    const out = await readLogs({ limit: 50_000 });
    expect(_logReaderStats().parsedLines - before).toBeLessThan(20_000);
    expect(out[0]?.id).toBe("e20000");
    expect(out.some((e) => e.id === "e0")).toBe(false);
  });
});

describe("log reader across many days", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vb-logs-days-"));
    setLogsDir(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The dashboard asks for the newest entries every few seconds. With more
  // day files than the old 4-file cache, each read walked newest first, left
  // the oldest four cached, and re-parsed every file next time, holding the
  // main thread for seconds (the admin's status turned "unreachable").
  it("a repeated read over more than four days parses nothing again", async () => {
    for (let d = 1; d <= 8; d++) {
      const parts: string[] = [];
      for (let i = 0; i < 500; i++) parts.push(line(d * 1000 + i, "y"));
      writeFileSync(join(dir, `2026-10-0${d}.jsonl`), parts.join(""));
    }
    expect((await readLogs({ limit: 50_000 })).length).toBe(4000);
    const before = _logReaderStats().parsedLines;
    expect((await readLogs({ limit: 50_000 })).length).toBe(4000);
    expect(_logReaderStats().parsedLines - before).toBe(0);
  });

  it("a cold read lets other work run while it parses", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 20_000; i++) parts.push(line(i, "z"));
    writeFileSync(join(dir, "2026-10-09.jsonl"), parts.join(""));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      await readLogs({ limit: 50_000 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("concurrent reads of one file share a parse", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 5_000; i++) parts.push(line(i, "w"));
    writeFileSync(join(dir, "2026-10-08.jsonl"), parts.join(""));
    const before = _logReaderStats().parsedLines;
    const [a, b] = await Promise.all([readLogs({ limit: 50_000 }), readLogs({ limit: 50_000 })]);
    expect(a.length).toBe(5000);
    expect(b.length).toBe(5000);
    expect(_logReaderStats().parsedLines - before).toBe(5000);
  });
});

describe("vaultbase update version validation", () => {
  it("accepts release tags with or without the v", () => {
    expect(normalizeReleaseTag("0.38.0")).toBe("v0.38.0");
    expect(normalizeReleaseTag("v0.38.0")).toBe("v0.38.0");
    expect(normalizeReleaseTag("v1.2.3-rc.1")).toBe("v1.2.3-rc.1");
  });

  it("rejects anything that isn't vX.Y.Z[-suffix]", () => {
    for (const bad of [
      "", "v", "1.2", "v1.2", "1.2.3.4", "latest", "v1.2.3/../../x", "v1.2.3?x=1",
      "v1.2.3#", "v1.2.3\n", "v1.2.3\nv1.2.3", "v1.2.3 ", " v1.2.3", "v1.2.3-", "v1.2.3-a b",
      "v1.2.3-.*", "vv1.2.3", "V1.2.3",
    ]) {
      expect(normalizeReleaseTag(bad)).toBeNull();
    }
  });

  it("a validated tag yields an identity regexp anchored on that tag only", () => {
    const tag = normalizeReleaseTag("1.2.3-rc.1")!;
    const re = new RegExp(releaseIdentityRegexp("vaultbase-sh/vaultbase", tag.slice(1)));
    expect(re.test("https://github.com/vaultbase-sh/vaultbase/.github/workflows/release.yml@refs/tags/v1.2.3-rc.1")).toBe(true);
    expect(re.test("https://github.com/vaultbase-sh/vaultbase/.github/workflows/release.yml@refs/tags/v1.2.3-rcX1")).toBe(false);
  });
});
