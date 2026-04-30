import Elysia from "elysia";
import { globalMetrics } from "../core/perf-metrics.ts";
import { getRawClient } from "../db/client.ts";
import { verifyAuthToken } from "../core/sec.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

interface SqliteSnapshot {
  page_count: number;
  page_size: number;
  cache_used_pages: number;
  wal_pages: number;
}

function sqliteSnapshot(): SqliteSnapshot | null {
  try {
    const c = getRawClient();
    const pc = c.query("PRAGMA page_count").get() as { page_count: number } | undefined;
    const ps = c.query("PRAGMA page_size").get() as { page_size: number } | undefined;
    // wal_checkpoint(PASSIVE) returns (busy, log_pages, checkpointed_pages); we just want log_pages.
    const wal = c.query("PRAGMA wal_checkpoint(PASSIVE)").get() as Record<string, unknown> | undefined;
    return {
      page_count: pc?.page_count ?? 0,
      page_size: ps?.page_size ?? 0,
      cache_used_pages: 0, // bun:sqlite doesn't expose `PRAGMA cache_used` reliably
      wal_pages: typeof wal?.["log"] === "number" ? wal["log"] as number : 0,
    };
  } catch {
    return null;
  }
}

export function makeMetricsPlugin(jwtSecret: string) {
  return new Elysia({ name: "metrics" })
    .get("/_/metrics", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      return {
        ...globalMetrics.snapshot(),
        sqlite: sqliteSnapshot(),
      };
    })
    .post("/_/metrics/reset", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      globalMetrics.reset();
      return { data: { reset: true } };
    });
}
