import { existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "fs";
import { appendFile as appendFileAsync } from "fs/promises";
import { join } from "path";
import { JSONPath } from "jsonpath-plus";

/**
 * Append-only file logger. Writes one JSON object per line (JSONL) to
 * `<logsDir>/YYYY-MM-DD.jsonl`. Files are never deleted by Vaultbase —
 * external rotation/archival is the operator's responsibility.
 */

export interface LogRuleEval {
  rule: string;
  collection: string;
  expression: string | null;
  outcome: "allow" | "deny" | "filter";
  reason: string;
}

export interface LogEntry {
  id: string;
  ts: string;            // ISO timestamp
  created_at: number;    // unix seconds (convenience for UI)
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string | null;
  auth_id?: string | null;
  auth_type?: "user" | "admin" | null;
  auth_email?: string | null;
  /** Set on user-token requests where the JWT carries an `impersonated_by` claim. */
  auth_impersonated_by?: string | null;
  /** Rules evaluated during this request (records API only). */
  rules?: LogRuleEval[];
  // Hook-emitted log entries set kind="hook" and carry an arbitrary message.
  kind?: "request" | "hook";
  message?: string;
  hook_collection?: string;
  hook_event?: string;
  hook_name?: string;
}

let configuredDir: string | null = null;

export function setLogsDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  configuredDir = dir;
}

function logsDir(): string | null {
  return configuredDir;
}

function utcDate(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Buffered async log writer (Phase 2 perf sprint) ─────────────────────────
//
// Sync `appendFileSync` on the request thread caused 0.2-2ms p50 + 5-15ms p99
// stalls under load (clustered tail-latency outliers at 918ms+ in c=1000
// benchmarks). Buffer in-memory and flush to disk asynchronously. Worst-case
// data loss on hard crash: 50ms or 4 MiB of log entries. Logs are
// observability, not authoritative state.
//
// Behaviour preserved:
//   - Same file naming (`<dir>/YYYY-MM-DD.jsonl`)
//   - Same line format (JSONL)
//   - `appendLogEntry` interface unchanged (sync-callable, fire-and-forget)
//   - `drainLogBuffer()` exposed for graceful-shutdown flush

class BufferedLogWriter {
  /** Per-file buffers — entries split by date so a midnight roll never gets cross-written. */
  private readonly buffers = new Map<string, string[]>();
  private bufferBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;
  /** 4 MiB. */
  private readonly maxBytes = 4 * 1024 * 1024;
  /** 50 ms. */
  private readonly flushIntervalMs = 50;

  enqueue(file: string, line: string): void {
    let arr = this.buffers.get(file);
    if (!arr) { arr = []; this.buffers.set(file, arr); }
    arr.push(line);
    this.bufferBytes += line.length;

    if (this.bufferBytes >= this.maxBytes) {
      void this.flushNow();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flushNow(); }, this.flushIntervalMs);
    }
  }

  /** Flush all pending buffers. Safe to call from drain(). */
  async flushNow(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    // Coalesce concurrent flushes — flush latest snapshot once.
    if (this.flushInFlight) { await this.flushInFlight; return; }

    if (this.buffers.size === 0) return;
    // Move buffers out — we cleared the LIVE Map below, so we have to take a
    // snapshot first or the iterator below sees zero entries (Map.clear()
    // mutates in place; a `const snapshot = this.buffers` aliases, doesn't copy).
    const snapshot = new Map(this.buffers);
    this.buffers.clear();
    this.bufferBytes = 0;

    this.flushInFlight = (async () => {
      const writes: Promise<void>[] = [];
      for (const [file, lines] of snapshot) {
        const data = lines.join("");
        writes.push(
          appendFileAsync(file, data, { encoding: "utf8" }).catch(() => { /* swallow */ }),
        );
      }
      await Promise.all(writes);
    })();
    try { await this.flushInFlight; } finally { this.flushInFlight = null; }
  }

  /** Synchronous fallback used during shutdown when the loop may not run. */
  flushSync(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const snapshot = new Map(this.buffers);
    this.buffers.clear();
    this.bufferBytes = 0;
    for (const [file, lines] of snapshot) {
      try { appendFileSync(file, lines.join(""), { encoding: "utf8" }); } catch { /* ignore */ }
    }
  }
}

const writer = new BufferedLogWriter();

/**
 * Drain pending log entries to disk. Call from graceful-shutdown handlers
 * (SIGTERM / SIGINT) before exit so the last 50ms of logs aren't lost.
 */
export async function drainLogBuffer(): Promise<void> {
  await writer.flushNow();
}

/** Synchronous variant — for `process.on('exit', …)` handlers where the loop is dead. */
export function drainLogBufferSync(): void {
  writer.flushSync();
}

export function appendLogEntry(entry: LogEntry): void {
  const dir = logsDir();
  if (!dir) return;
  const date = entry.ts.slice(0, 10); // ISO YYYY-MM-DD
  const file = join(dir, `${date}.jsonl`);
  writer.enqueue(file, JSON.stringify(entry) + "\n");
}

export interface HookLogInput {
  collection?: string;
  event?: string;
  name?: string;
  message: string;
  auth?: { id?: string; type?: "user" | "admin"; email?: string } | null;
}

/** Append a log entry produced by a JS hook calling `helpers.log(...)`. */
export function appendHookLog(input: HookLogInput): void {
  const tsSec = Math.floor(Date.now() / 1000);
  const collection = input.collection ?? "";
  const event = input.event ?? "";
  const name = input.name ?? "";
  const labelParts = [name, collection, event].filter(Boolean);
  const path = labelParts.length > 0 ? labelParts.join(":") : "(hook)";
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    ts: new Date(tsSec * 1000).toISOString(),
    created_at: tsSec,
    method: "HOOK",
    path,
    status: 200,
    duration_ms: 0,
    ip: null,
    auth_id: input.auth?.id ?? null,
    auth_type: input.auth?.type ?? null,
    auth_email: input.auth?.email ?? null,
    kind: "hook",
    message: input.message,
    hook_collection: collection,
    hook_event: event,
    hook_name: name,
  };
  appendLogEntry(entry);
}

/** List available log file dates (sorted desc — newest first). */
export function listLogDates(): Array<{ date: string; size: number; lines: number | null }> {
  const dir = logsDir();
  if (!dir || !existsSync(dir)) return [];
  const out: Array<{ date: string; size: number; lines: number | null }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const date = name.slice(0, -6);
    const full = join(dir, name);
    try {
      const s = statSync(full);
      out.push({ date, size: s.size, lines: null });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

interface ReadOptions {
  /** Date range (inclusive). YYYY-MM-DD strings. */
  from?: string;
  to?: string;
  /** Limit number of returned entries (after filtering). */
  limit?: number;
}

function datesInRange(from?: string, to?: string): string[] {
  const all = listLogDates().map((d) => d.date);
  return all.filter((d) => (!from || d >= from) && (!to || d <= to));
}

/** Read entries from file(s), newest first. Streams line-by-line. */
export async function readLogs(opts: ReadOptions = {}): Promise<LogEntry[]> {
  // Flush pending buffered writes so we never read stale logs — the cost is
  // a single async fs.appendFile per buffered date file. Admin logs UI hits
  // this and absolutely must see entries from the request that just finished.
  await drainLogBuffer();
  const dir = logsDir();
  if (!dir) return [];
  const dates = datesInRange(opts.from, opts.to);
  const limit = opts.limit ?? 1000;
  const out: LogEntry[] = [];
  for (const date of dates) {
    const file = join(dir, `${date}.jsonl`);
    const text = await Bun.file(file).text().catch(() => "");
    if (!text) continue;
    const lines = text.split("\n");
    // Iterate newest-first within the file
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i]?.trim();
      if (!ln) continue;
      try {
        out.push(JSON.parse(ln) as LogEntry);
        if (out.length >= limit) return out;
      } catch { /* skip malformed line */ }
    }
  }
  return out;
}

export interface SearchResult {
  matched: number;
  scanned: number;
  results: unknown[];
}

/**
 * Run a JSONPath expression against entries in the requested date range.
 * Each entry is the haystack; matches are returned per-entry.
 */
export async function searchLogs(
  jsonpath: string,
  opts: ReadOptions = {}
): Promise<SearchResult> {
  const entries = await readLogs({ ...opts, limit: opts.limit ?? 100_000 });
  const results: unknown[] = [];
  let matched = 0;
  const scanned = entries.length;
  for (const e of entries) {
    let m: unknown[] = [];
    try {
      m = JSONPath({ path: jsonpath, json: e as unknown as Record<string, unknown> }) as unknown[];
    } catch {
      // Invalid expression — bail out with empty results
      return { matched: 0, scanned, results: [] };
    }
    if (Array.isArray(m) && m.length > 0) {
      matched++;
      results.push({ entry: e, matches: m });
      if (results.length >= (opts.limit ?? 500)) break;
    }
  }
  return { matched, scanned, results };
}
