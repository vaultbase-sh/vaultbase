import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { admin, users } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";

function getSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function makeAuthPlugin(jwtSecret: string) {
  return new Elysia({ name: "auth" })
    .post(
      "/api/admin/setup",
      async ({ body, set }) => {
        const db = getDb();
        const existing = await db.select().from(admin).limit(1);
        if (existing.length > 0) {
          set.status = 400;
          return { error: "Admin already set up", code: 400 };
        }
        const hash = await Bun.password.hash(body.password);
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await db.insert(admin).values({ id, email: body.email, password_hash: hash, created_at: now });
        return { data: { id, email: body.email } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    .post(
      "/api/admin/auth/login",
      async ({ body, set }) => {
        const db = getDb();
        const rows = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
        const a = rows[0];
        if (!a) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const valid = await Bun.password.verify(body.password, a.password_hash);
        if (!valid) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const token = await new jose.SignJWT({ id: a.id, email: a.email })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("admin")
          .setExpirationTime("7d")
          .sign(getSecret(jwtSecret));
        return { data: { token, admin: { id: a.id, email: a.email } } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    .get("/api/admin/auth/me", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      try {
        const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "admin" });
        return { data: payload };
      } catch {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
    })
    .post(
      "/api/auth/:collection/register",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const db = getDb();
        const existing = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
        if (existing.length > 0) { set.status = 400; return { error: "Email already registered", code: 400 }; }
        const hash = await Bun.password.hash(body.password);
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const { email, password, ...extra } = body;
        await db.insert(users).values({
          id,
          collection_id: col.id,
          email,
          password_hash: hash,
          data: JSON.stringify(extra),
          created_at: now,
          updated_at: now,
        });
        return { data: { id, email } };
      },
      {
        body: t.Object(
          { email: t.String(), password: t.String() },
          { additionalProperties: true }
        ),
      }
    )
    .post(
      "/api/auth/:collection/login",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const db = getDb();
        const rows = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
        const u = rows[0];
        if (!u) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const valid = await Bun.password.verify(body.password, u.password_hash);
        if (!valid) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const token = await new jose.SignJWT({ id: u.id, email: u.email, collection: params.collection })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("user")
          .setExpirationTime("7d")
          .sign(getSecret(jwtSecret));
        return { data: { token, record: { id: u.id, email: u.email } } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    .get("/api/auth/me", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      try {
        const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "user" });
        return { data: payload };
      } catch {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
    });
}
