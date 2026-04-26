import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;
let _client: Database | null = null;

export function getDb(): DB {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

/**
 * Initialize SQLite. Accepts:
 *   ":memory:"             — in-memory DB (tests)
 *   "file:./path/data.db"  — file URL (legacy libSQL syntax, parsed)
 *   "./path/data.db"       — direct path
 */
export function initDb(url: string): DB {
  let path = url;
  if (url.startsWith("file:")) path = url.slice(5);
  _client = new Database(path, { create: true });
  _client.exec("PRAGMA journal_mode = WAL;");
  _db = drizzle(_client, { schema });
  return _db;
}

export function closeDb(): void {
  _client?.close();
  _client = null;
  _db = null;
}
