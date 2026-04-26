import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.ts";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;

export function getDb(): DB {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

export function initDb(url: string): DB {
  const client = createClient({ url });
  _db = drizzle(client, { schema });
  return _db;
}
