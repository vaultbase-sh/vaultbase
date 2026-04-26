# Request Logging Design

**Goal:** Record every HTTP request to SQLite, expose via admin API, display in the Logs UI page.

**Architecture:** Elysia WeakMap-based timing middleware writes fire-and-forget to `vaultbase_logs` table in the existing DB. Admin-only GET endpoint returns paginated, filterable entries. Frontend Logs page replaces mock data with real fetch.

---

## Schema

Table: `vaultbase_logs`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | uuid |
| method | TEXT | GET / POST / PATCH / DELETE |
| path | TEXT | pathname only, no query string |
| status | INTEGER | HTTP status code |
| duration_ms | INTEGER | request duration in ms |
| ip | TEXT nullable | from x-forwarded-for or socket |
| created_at | INTEGER | unixepoch() |

Cap: trim oldest rows when count exceeds 10 000 (delete oldest 2 000).

## Middleware

File: `src/api/logs.ts`

- `const timings = new WeakMap<Request, number>()`
- `onRequest({ as: "global" })` — `timings.set(request, Date.now())`
- `onAfterHandle({ as: "global" })` — compute `ms`, fire-and-forget insert
- `onError({ as: "global" })` — same, status from `error.status ?? 500`
- **Skip logging** paths: `/_/`, `/api/admin/logs`, `/realtime`, `/api/health`

## API Endpoint

`GET /api/admin/logs` — admin JWT required

Query params:
- `page` (default 1), `perPage` (default 50, max 200)
- `method` — ALL | GET | POST | PATCH | DELETE
- `status` — all | 2xx | 4xx | 5xx

Response shape:
```json
{ "data": [...], "page": 1, "perPage": 50, "totalItems": 1234, "totalPages": 25 }
```

Each entry: `{ id, method, path, status, duration_ms, ip, created_at }`

## Frontend

Replace mock `MOCK_LOGS` in `admin/src/pages/Logs.tsx`:
- Fetch from `/api/admin/logs?page=N&perPage=50&method=X&status=Y`
- Auto-refresh every 2s when live mode active (abort previous fetch)
- Pagination controls wired to `page` state
- Method/status dropdowns wire to query params
- Drawer stays — shows real row data

## Files changed

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `logs` table export |
| `src/db/migrate.ts` | Add CREATE TABLE IF NOT EXISTS |
| `src/api/logs.ts` | New — middleware + endpoint |
| `src/server.ts` | `.use(makeLogsPlugin())` before other plugins |
| `admin/src/pages/Logs.tsx` | Replace mock data with real API fetch |
