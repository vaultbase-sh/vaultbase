import { and, count, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";
import { verifyAuthToken } from "../core/sec.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — checks signature, audience, expiry, issuer,
  // jti revocation, and password_reset_at. Fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

interface UserRow {
  id: string;
  collection_id: string;
  email: string;
  email_verified: number;
  totp_enabled: number;
  is_anonymous: number;
  data: string;
  created_at: number;
  updated_at: number;
}

/** Reserved keys derived from real columns — must not be shadowed by JSON `data`. */
const RESERVED_USER_KEYS = new Set([
  "id", "email", "verified", "mfa_enabled", "anonymous", "created", "updated",
  // back-compat: legacy stored payloads sometimes carried these too
  "email_verified", "totp_enabled", "is_anonymous",
]);

function shape(row: UserRow): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data ?? "{}") as Record<string, unknown>; } catch { /* keep empty */ }
  // Strip reserved keys from `data` so a legacy round-trip can't override
  // the canonical column-derived values (the cause of the "MFA still showing
  // active after disable" bug).
  for (const k of RESERVED_USER_KEYS) {
    if (k in data) delete data[k];
  }
  return {
    id: row.id,
    email: row.email,
    ...data,
    verified: row.email_verified === 1,
    mfa_enabled: row.totp_enabled === 1,
    anonymous: row.is_anonymous === 1,
    created: row.created_at,
    updated: row.updated_at,
  };
}

export function makeAuthUsersPlugin(jwtSecret: string) {
  return new Elysia({ name: "auth-users" })
    .get("/api/admin/users/:collection", async ({ params, query, request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const page = query.page ? Math.max(1, parseInt(query.page)) : 1;
      const perPage = query.perPage ? Math.min(500, Math.max(1, parseInt(query.perPage))) : 30;
      const offset = (page - 1) * perPage;

      const db = getDb();
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.collection_id, col.id))
        .limit(perPage)
        .offset(offset);
      const totals = await db
        .select({ c: count() })
        .from(users)
        .where(eq(users.collection_id, col.id));
      const totalItems = totals[0]?.c ?? 0;
      return {
        data: rows.map((r) => shape(r as UserRow)),
        page,
        perPage,
        totalItems,
        totalPages: Math.ceil(totalItems / perPage),
      };
    }, {
      query: t.Object({
        page: t.Optional(t.String()),
        perPage: t.Optional(t.String()),
      }),
    })

    .patch("/api/admin/users/:collection/:id", async ({ params, body, request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }

      const db = getDb();
      const existing = await db
        .select()
        .from(users)
        .where(and(eq(users.id, params.id), eq(users.collection_id, col.id)))
        .limit(1);
      if (existing.length === 0) { set.status = 404; return { error: "User not found", code: 404 }; }
      const u = existing[0]!;

      const update: Record<string, unknown> = {};
      if (typeof body.email === "string") {
        // Email uniqueness within the collection
        const dup = await db
          .select()
          .from(users)
          .where(and(eq(users.email, body.email), eq(users.collection_id, col.id)))
          .limit(1);
        if (dup.length > 0 && dup[0]!.id !== u.id) {
          set.status = 400; return { error: "Email already in use", code: 400 };
        }
        update["email"] = body.email;
      }
      if (typeof body.verified === "boolean") {
        update["email_verified"] = body.verified ? 1 : 0;
      }
      // Admin-side MFA reset (account recovery). `true` is rejected — turning
      // MFA on requires the user to scan a QR via /totp/setup + /totp/confirm.
      if (body.mfa_enabled === false) {
        update["totp_enabled"] = 0;
        update["totp_secret"] = null;
      } else if (body.mfa_enabled === true) {
        set.status = 422;
        return { error: "Admins can only disable MFA; users enroll via /totp/setup", code: 422 };
      }
      if (body.data !== undefined && typeof body.data === "object" && body.data !== null) {
        // Strip reserved keys so a legacy/buggy client can't poison the JSON
        // blob with values that shadow column-derived fields on read.
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body.data as Record<string, unknown>)) {
          if (!RESERVED_USER_KEYS.has(k)) cleaned[k] = v;
        }
        update["data"] = JSON.stringify(cleaned);
      }
      if (Object.keys(update).length === 0) {
        return { data: shape(u as UserRow) };
      }
      update["updated_at"] = Math.floor(Date.now() / 1000);
      await db.update(users).set(update).where(eq(users.id, u.id));

      const refreshed = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
      return { data: shape(refreshed[0] as UserRow) };
    }, {
      body: t.Object({
        email:       t.Optional(t.String()),
        verified:    t.Optional(t.Boolean()),
        mfa_enabled: t.Optional(t.Boolean()),
        data:        t.Optional(t.Record(t.String(), t.Any())),
      }),
    })

    .delete("/api/admin/users/:collection/:id", async ({ params, request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const db = getDb();
      await db
        .delete(users)
        .where(and(eq(users.id, params.id), eq(users.collection_id, col.id)));
      return { data: null };
    });
}
