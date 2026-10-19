import { count, eq, sql } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { HASH_OPTS } from "../core/sec.ts";
import { validatePassword } from "../core/password-policy.ts";
import { adminGuard } from "./_admin.ts";

/**
 * Admin emails are matched without regard to case, so `Ops@` and `ops@` are
 * one account. Two admins made before this that differ only in case each
 * still sign in: an exact match comes first.
 */
export function adminByEmail(email: string) {
  const e = email.trim();
  return getDb().select().from(admin)
    .where(sql`lower(${admin.email}) = ${e.toLowerCase()}`)
    .orderBy(sql`case when ${admin.email} = ${e} then 0 else 1 end`)
    .limit(1);
}

export function makeAdminsPlugin(jwtSecret: string) {
  return new Elysia({ name: "admins" })
    .use(adminGuard(jwtSecret))
    // List all admins
    .get("/admin/admins", async () => {
      const db = getDb();
      const rows = await db
        .select({ id: admin.id, email: admin.email, created_at: admin.created_at })
        .from(admin);
      return { data: rows };
    }, { requireAdmin: true })

    // Create new admin
    .post(
      "/admin/admins",
      async ({ body, set }) => {
        {
          const pwErr = await validatePassword(body.password);
          if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
        }
        const db = getDb();
        const email = body.email.trim();
        const existing = await adminByEmail(email);
        if (existing.length > 0) {
          set.status = 400;
          return { error: "Email already in use", code: 400 };
        }
        const hash = await Bun.password.hash(body.password, HASH_OPTS);
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await db.insert(admin).values({ id, email, password_hash: hash, created_at: now });
        return { data: { id, email, created_at: now } };
      },
      { requireAdmin: true, body: t.Object({ email: t.String(), password: t.String() }) }
    )

    // Update your own admin account (email and/or password)
    .patch(
      "/admin/admins/:id",
      async ({ admin: me, params, body, set }) => {
        // Only your own account. Setting another admin's email or password is
        // a takeover of their sign-in, with everything done afterwards
        // attributed to them. A locked-out admin is recovered from the server
        // with `vaultbase setup-admin --force`.
        if (me.id !== params.id) {
          set.status = 403;
          return { error: "You can only change your own email and password", code: 403 };
        }
        const db = getDb();
        const target = await db.select().from(admin).where(eq(admin.id, params.id)).limit(1);
        if (target.length === 0) { set.status = 404; return { error: "Admin not found", code: 404 }; }

        const update: { email?: string; password_hash?: string; password_reset_at?: number } = {};
        if (body.email !== undefined) {
          // Check email uniqueness
          const dup = await adminByEmail(body.email);
          if (dup.length > 0 && dup[0]!.id !== params.id) {
            set.status = 400;
            return { error: "Email already in use", code: 400 };
          }
          update.email = body.email.trim();
        }
        if (body.password !== undefined) {
          const pwErr = await validatePassword(body.password);
          if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
          update.password_hash = await Bun.password.hash(body.password, HASH_OPTS);
          // End that admin's existing sessions (a leaked token stops working).
          update.password_reset_at = Math.floor(Date.now() / 1000);
        }
        if (Object.keys(update).length === 0) {
          return { data: { id: params.id, email: target[0]!.email } };
        }
        await db.update(admin).set(update).where(eq(admin.id, params.id));
        return { data: { id: params.id, email: update.email ?? target[0]!.email } };
      },
      {
        requireAdmin: true,
        body: t.Object({
          email: t.Optional(t.String()),
          password: t.Optional(t.String()),
        }),
      }
    )

    // Delete admin (cannot delete self, cannot delete last admin)
    .delete("/admin/admins/:id", async ({ admin: me, params, set }) => {
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
    }, { requireAdmin: true });
}
