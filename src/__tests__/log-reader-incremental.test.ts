import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLogs, setLogsDir, _logReaderStats } from "../core/file-logger.ts";

// The admin Logs page polls readLogs, which re-read and JSON-parsed the whole
// day's JSONL file each time. Files are append-only, so the reader now parses
// only bytes appended since the last read.

let dir: string;
const file = () => join(dir, "2026-10-10.jsonl");
const line = (i: number) => JSON.stringify({ id: `e${i}`, method: "GET", path: `/p/${i}`, status: 200 }) + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vb-logread-"));
  setLogsDir(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ids = (entries: Array<{ id?: unknown }>) => entries.map((e) => e.id);

describe("incremental log reader", () => {
  it("returns newest first and picks up appended lines", async () => {
    writeFileSync(file(), line(1) + line(2));
    expect(ids(await readLogs({ limit: 10 }))).toEqual(["e2", "e1"]);
    appendFileSync(file(), line(3));
    expect(ids(await readLogs({ limit: 10 }))).toEqual(["e3", "e2", "e1"]);
  });

  it("parses only the appended bytes on the next read", async () => {
    let body = "";
    for (let i = 0; i < 500; i++) body += line(i);
    writeFileSync(file(), body);
    await readLogs({ limit: 1000 });
    const before = _logReaderStats().parsedLines;
    appendFileSync(file(), line(500) + line(501));
    const out = await readLogs({ limit: 1000 });
    expect(out[0]?.id).toBe("e501");
    expect(out.length).toBe(502);
    expect(_logReaderStats().parsedLines - before).toBe(2);
  });

  it("re-reads a file that shrank (rotated / truncated)", async () => {
    writeFileSync(file(), line(1) + line(2) + line(3));
    await readLogs({ limit: 10 });
    writeFileSync(file(), line(9));
    expect(ids(await readLogs({ limit: 10 }))).toEqual(["e9"]);
  });

  it("holds back a partial trailing line until it is complete", async () => {
    writeFileSync(file(), line(1) + line(2).slice(0, 10));
    expect(ids(await readLogs({ limit: 10 }))).toEqual(["e1"]);
    appendFileSync(file(), line(2).slice(10));
    expect(ids(await readLogs({ limit: 10 }))).toEqual(["e2", "e1"]);
  });
});
