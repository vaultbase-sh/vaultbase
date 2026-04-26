/**
 * Dev-only: wipe the database and reset to fresh state.
 * Deletes data.db, uploads/, and .secret from the data dir.
 *
 * Usage:
 *   bun run db:reset           # asks for confirmation
 *   bun run db:reset --force   # skip confirmation
 */

import { existsSync, rmSync } from "fs";
import { join } from "path";

if (process.env["NODE_ENV"] === "production") {
  console.error("✗ db:reset is dev-only. Refusing to run with NODE_ENV=production.");
  process.exit(1);
}

const dataDir = process.env["VAULTBASE_DATA_DIR"] ?? "./vaultbase_data";
const force = process.argv.includes("--force");

const targets = [
  join(dataDir, "data.db"),
  join(dataDir, "data.db-shm"),
  join(dataDir, "data.db-wal"),
  join(dataDir, ".secret"),
  join(dataDir, "uploads"),
];

const existing = targets.filter(existsSync);

if (existing.length === 0) {
  console.log(`✓ Data dir already clean: ${dataDir}`);
  process.exit(0);
}

console.log(`\nAbout to delete from ${dataDir}:`);
for (const t of existing) console.log(`  - ${t.replace(`${dataDir}/`, "")}`);
console.log();

if (!force) {
  process.stdout.write('Type "reset" to confirm: ');
  for await (const line of console) {
    if (line.trim() === "reset") break;
    console.error("✗ Aborted.");
    process.exit(1);
  }
}

let failed = 0;
for (const t of existing) {
  try {
    rmSync(t, { recursive: true, force: true });
    console.log(`  ✓ Deleted ${t}`);
  } catch (e) {
    console.error(`  ✗ Failed to delete ${t}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n✗ ${failed} item(s) failed to delete. Stop the server first.`);
  process.exit(1);
}

console.log("\n✓ Database reset. Run `bun src/index.ts` to recreate.");
