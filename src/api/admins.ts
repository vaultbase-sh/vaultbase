import { count, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { HASH_OPTS, verifyAuthToken } from "../core/sec.ts";

/** Minimum admin password length — matches `PASSWORD_MIN_LENGTH` in auth.ts. */
const ADMIN_PASSWORD_MIN_LENGTH = 12;

interface AdminClaims {
  id: string;
  email: string;
}

async function verifyAdmin(
  request: Request,
  jwtSecret: string
): Promise<AdminClaims | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

export function makeAdminsPlugin(jwtSecret: string) {
  return new Elysia({ name: "admins" })
    // List all admins
    .get("/api/admin/admins", async ({ request, set }) => {
      const me = await verifyAdmin(request, jwtSecret);
      if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const db = getDb();
      const rows = await db
        .select({ id: admin.id, email: admin.email, created_at: admin.created_at })
        .from(admin);
      return { data: rows };
    })

    // Create new admin
    .post(
      "/api/admin/admins",
      async ({ request, body, set }) => {
        const me = await verifyAdmin(request, jwtSecret);
        if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        if (body.password.length < ADMIN_PASSWORD_MIN_LENGTH) {
          set.status = 422;
          return { error: `Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`, code: 422 };
        }
        const db = getDb();
        const existing = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
        if (existing.length > 0) {
          set.status = 400;
          return { error: "Email already in use", code: 400 };
        }
        const hash = await Bun.password.hash(body.password, HASH_OPTS);
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await db.insert(admin).values({ id, email: body.email, password_hash: hash, created_at: now });
        return { data: { id, email: body.email, created_at: now } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )

    // Update admin (email and/or password)
    .patch(
      "/api/admin/admins/:id",
      async ({ request, params, body, set }) => {
        const me = await verifyAdmin(request, jwtSecret);
        if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const db = getDb();
        const target = await db.select().from(admin).where(eq(admin.id, params.id)).limit(1);
        if (target.length === 0) { set.status = 404; return { error: "Admin not found", code: 404 }; }

        const update: { email?: string; password_hash?: string } = {};
        if (body.email !== undefined) {
          // Check email uniqueness
          const dup = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
          if (dup.length > 0 && dup[0]!.id !== params.id) {
            set.status = 400;
            return { error: "Email already in use", code: 400 };
          }
          update.email = body.email;
        }
        if (body.password !== undefined) {
          if (body.password.length < ADMIN_PASSWORD_MIN_LENGTH) {
            set.status = 422;
            return { error: `Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`, code: 422 };
          }
          update.password_hash = await Bun.password.hash(body.password, HASH_OPTS);
        }
        if (Object.keys(update).length === 0) {
          return { data: { id: params.id, email: target[0]!.email } };
        }
        await db.update(admin).set(update).where(eq(admin.id, params.id));
        return { data: { id: params.id, email: update.email ?? target[0]!.email } };
      },
      {
        body: t.Object({
          email: t.Optional(t.String()),
          password: t.Optional(t.String()),
        }),
      }
    )

    // Delete admin (cannot delete self, cannot delete last admin)
    .delete("/api/admin/admins/:id", async ({ request, params, set }) => {
      const me = await verifyAdmin(request, jwtSecret);
      if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      if (me.id === params.id) {
        set.status = 400;
        return { error: "Cannot delete your own account", code: 400 };
      }
      const db = getDb();
      const countRows = await db.select({ c: count() }).from(admin);
      const total = countRows[0]?.c ?? 0;
      if (total <= 1) {
        set.status = 400;
        return { error: "Cannot delete the last admin", code: 400 };
      }
      const target = await db.select().from(admin).where(eq(admin.id, params.id)).limit(1);
      if (target.length === 0) { set.status = 404; return { error: "Admin not found", code: 404 }; }
      await db.delete(admin).where(eq(admin.id, params.id));
      return { data: null };
    });
}
