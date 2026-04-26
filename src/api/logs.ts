import { and, asc, count, desc, eq, gte, inArray, like, lt, not } from "drizzle-orm";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { logs, type NewLog } from "../db/schema.ts";

const SKIP_PREFIXES = ["/_/", "/api/admin/logs", "/realtime", "/api/health"];

function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

const LOG_MAX = 10_000;
const LOG_KEEP = 8_000;

export async function insertLog(
  method: string,
  path: string,
  status: number,
  duration_ms: number,
  ip: string | null
): Promise<void> {
  const db = getDb();
  const row: NewLog = {
    id: crypto.randomUUID(),
    method,
    path,
    status,
    duration_ms,
    ip,
    created_at: Math.floor(Date.now() / 1000),
  };
  await db.insert(logs).values(row);
  void trimLogs(LOG_MAX, LOG_KEEP);
}

export async function trimLogs(max: number, keepCount: number): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ c: count() }).from(logs);
  const total = row?.c ?? 0;
  if (total <= max) return;
  const toDelete = total - keepCount;
  const oldest = await db
    .select({ id: logs.id })
    .from(logs)
    .orderBy(asc(logs.created_at))
    .limit(toDelete);
  if (oldest.length === 0) return;
  const ids = oldest.map((r) => r.id);
  await db.delete(logs).where(inArray(logs.id, ids));
}

export interface ListLogsOptions {
  page: number;
  perPage: number;
  method: string;
  status: string;
  includeAdmin: boolean;
}

export async function listLogs(opts: ListLogsOptions) {
  const db = getDb();
  const { page, perPage, method, status, includeAdmin } = opts;
  const offset = (page - 1) * perPage;

  const conditions = [];
  if (!includeAdmin) conditions.push(not(like(logs.path, "/api/admin/%")));
  if (method !== "all") conditions.push(eq(logs.method, method));
  if (status === "2xx") conditions.push(and(gte(logs.status, 200), lt(logs.status, 300))!);
  if (status === "4xx") conditions.push(and(gte(logs.status, 400), lt(logs.status, 500))!);
  if (status === "5xx") conditions.push(gte(logs.status, 500));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db.select().from(logs).where(where).orderBy(desc(logs.created_at)).limit(perPage).offset(offset),
    db.select({ c: count() }).from(logs).where(where),
  ]);

  const totalItems = countResult[0]?.c ?? 0;
  return {
    data: rows,
    page,
    perPage,
    totalItems,
    totalPages: Math.ceil(totalItems / perPage),
  };
}

export function makeLogsPlugin(jwtSecret: string) {
  const timings = new WeakMap<Request, number>();
  const secret = new TextEncoder().encode(jwtSecret);

  return new Elysia({ name: "logs" })
    .onRequest(({ request }) => {
      timings.set(request, Date.now());
    })
    .onAfterHandle({ as: "global" }, ({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (shouldSkip(path)) return;
      const start = timings.get(request) ?? Date.now();
      timings.delete(request);
      const ms = Date.now() - start;
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
      void insertLog(request.method, path, Number(set.status ?? 200), ms, ip);
    })
    .onError({ as: "global" }, ({ request, error }) => {
      const path = new URL(request.url).pathname;
      if (shouldSkip(path)) return;
      const start = timings.get(request) ?? Date.now();
      timings.delete(request);
      const ms = Date.now() - start;
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
      const status = "status" in error ? Number((error as { status: number }).status) : 500;
      void insertLog(request.method, path, status, ms, ip);
    })
    .get(
      "/api/admin/logs",
      async ({ request, query, set }) => {
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        try {
          await jose.jwtVerify(token, secret, { audience: "admin" });
        } catch {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        const page = Math.max(1, parseInt(query.page ?? "1") || 1);
        const perPage = Math.min(200, Math.max(1, parseInt(query.perPage ?? "50") || 50));
        return listLogs({
          page,
          perPage,
          method: query.method ?? "all",
          status: query.status ?? "all",
          includeAdmin: query.includeAdmin === "true",
        });
      },
      {
        query: t.Object({
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
          method: t.Optional(t.String()),
          status: t.Optional(t.String()),
          includeAdmin: t.Optional(t.String()),
        }),
      }
    );
}
