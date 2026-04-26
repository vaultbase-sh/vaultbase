import { loadConfig } from "./config.ts";
import { initDb, getDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { admin } from "./db/schema.ts";
import { createServer } from "./server.ts";

async function main() {
  const config = await loadConfig();

  initDb(`file:${config.dbPath}`);
  await runMigrations();

  const db = getDb();
  const rows = await db.select().from(admin).limit(1);
  const adminExists = rows.length > 0;

  const server = createServer(config);
  server.listen(config.port);

  const base = `http://localhost:${config.port}`;

  if (!adminExists) {
    console.log(
      `\n┌─────────────────────────────────────────────┐\n│  Vaultbase is running at ${base}   │\n│  Set up your admin account:                  │\n│  ${base}/_/setup                  │\n└─────────────────────────────────────────────┘\n`
    );
  } else {
    console.log(`Vaultbase running at ${base}`);
  }
}

main().catch(console.error);
