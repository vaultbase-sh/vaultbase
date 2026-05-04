/**
 * `vaultbase doctor` — pre-flight checks for the v0.11 auth-collection
 * migration. Reports on anything that would block or silently lose data,
 * exits non-zero if a blocker is present so CI / scripts can guard.
 *
 * Checks:
 *   - Custom field name collisions with auth columns (email, password_hash,
 *     ...) per auth collection. Blocker: rename the field first.
 *   - Stranded rows in `vb_<auth-col>` lacking email/password — typically
 *     hand-INSERTed via run_sql or CSV import. Blocker: drop or migrate
 *     manually before the auth-table swap.
 *   - Duplicate emails within an auth collection (would break the new
 *     UNIQUE index). Blocker: reconcile.
 *   - JSON `data` keys on `vaultbase_users` that don't map to any custom
 *     field. Warning: data lost on migration unless field added.
 *
 * Read-only — never mutates state. Just inspects.
 */

import { Database } from "bun:sqlite";

interface DoctorIssue {
  level: "blocker" | "warning";
  collection: string;
  message: string;
}

const AUTH_RESERVED_NAMES = new Set([
  "email", "password_hash", "email_verified", "totp_secret",
  "totp_enabled", "is_anonymous", "password_reset_at",
]);

export interface DoctorReport {
  blockers: DoctorIssue[];
  warnings: DoctorIssue[];
  ok: boolean;
}

export function runDoctor(dbPath: string): DoctorReport {
  const db = new Database(dbPath, { readonly: true, create: false });
  const blockers: DoctorIssue[] = [];
  const warnings: DoctorIssue[] = [];

  try {
    // No legacy auth state? Doctor is always green for fresh installs.
    const usersExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_users'`,
    ).get() as { name: string } | undefined;
    const collectionsExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_collections'`,
    ).get() as { name: string } | undefined;
    if (!collectionsExists) return { blockers, warnings, ok: true };

    const authCols = db.prepare(
      `SELECT id, name, fields FROM vaultbase_collections WHERE type='auth'`,
    ).all() as Array<{ id: string; name: string; fields: string }>;

    for (const col of authCols) {
      let fields: Array<{ name?: unknown; implicit?: unknown; system?: unknown; type?: unknown }> = [];
      try { fields = JSON.parse(col.fields || "[]") as typeof fields; } catch { /* skip */ }
      const customNames = new Set(
        fields
          .filter((f) => typeof f.name === "string" && !f.implicit && !f.system && f.type !== "autodate")
          .map((f) => f.name as string),
      );

      // 1. Reserved name collision.
      for (const name of customNames) {
        if (AUTH_RESERVED_NAMES.has(name)) {
          blockers.push({
            level: "blocker",
            collection: col.name,
            message: `custom field '${name}' collides with the reserved auth column. Rename via the schema editor before migrating.`,
          });
        }
      }

      // 2. Stranded rows in vb_<col>.
      const tbl = `vb_${col.name}`;
      const tblExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(tbl) as { name: string } | undefined;
      if (tblExists) {
        const cnt = (db.prepare(`SELECT count(*) AS n FROM "${tbl.replace(/"/g, '""')}"`).get() as { n: number })?.n ?? 0;
        if (cnt > 0) {
          // Determine if these rows are pre-migration shape (no email column
          // yet) or stranded data (email column present but NULL).
          const cols = db.prepare(`PRAGMA table_info("${tbl.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
          const colNames = new Set(cols.map((c) => c.name));
          if (!colNames.has("email")) {
            blockers.push({
              level: "blocker",
              collection: col.name,
              message: `${tbl} contains ${cnt} row(s) but lacks the auth columns. Pre-v0.11 stranded data. Inspect via the SQL runner; either drop the rows or re-create them via the auth signup flow before migrating.`,
            });
          } else {
            const orphans = (db.prepare(`SELECT count(*) AS n FROM "${tbl.replace(/"/g, '""')}" WHERE email IS NULL OR password_hash IS NULL`).get() as { n: number })?.n ?? 0;
            if (orphans > 0) {
              blockers.push({
                level: "blocker",
                collection: col.name,
                message: `${tbl} has ${orphans} row(s) with NULL email or password_hash. Migration won't fabricate credentials; drop those rows or fix them first.`,
              });
            }
          }
        }
      }

      // 3. Duplicate emails in vaultbase_users for this collection.
      if (usersExists) {
        const dups = (db.prepare(
          `SELECT email, count(*) AS n FROM vaultbase_users
           WHERE collection_id = ? GROUP BY email HAVING n > 1 LIMIT 10`,
        ).all(col.id) as Array<{ email: string; n: number }>);
        for (const d of dups) {
          blockers.push({
            level: "blocker",
            collection: col.name,
            message: `duplicate email '${d.email}' x${d.n} in vaultbase_users — UNIQUE index on the per-collection table will reject this.`,
          });
        }

        // 4. JSON `data` keys not mapped to any custom field.
        try {
          const rows = db.prepare(
            `SELECT data FROM vaultbase_users WHERE collection_id = ? LIMIT 200`,
          ).all(col.id) as Array<{ data: string }>;
          const seen = new Set<string>();
          for (const r of rows) {
            try {
              const parsed = JSON.parse(r.data || "{}") as Record<string, unknown>;
              for (const k of Object.keys(parsed)) seen.add(k);
            } catch { /* skip */ }
          }
          for (const k of seen) {
            if (!customNames.has(k)) {
              warnings.push({
                level: "warning",
                collection: col.name,
                message: `JSON key '${k}' present in vaultbase_users.data but no matching custom field on the collection. Will be dropped on migration unless you add a field.`,
              });
            }
          }
        } catch { /* shrug */ }
      }
    }
  } finally {
    db.close();
  }

  return { blockers, warnings, ok: blockers.length === 0 };
}

/** CLI entry point. Returns the exit code (0 ok, 1 blockers found). */
export function runDoctorCli(_argv: readonly string[], dbPath: string): number {
  const report = runDoctor(dbPath);
  if (report.ok && report.warnings.length === 0) {
    process.stdout.write("✓ vaultbase doctor — clean. v0.11 migration is safe.\n");
    return 0;
  }
  if (report.blockers.length > 0) {
    process.stdout.write(`\n✖ ${report.blockers.length} blocker(s):\n`);
    for (const i of report.blockers) {
      process.stdout.write(`  [${i.collection}] ${i.message}\n`);
    }
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\n⚠ ${report.warnings.length} warning(s):\n`);
    for (const i of report.warnings) {
      process.stdout.write(`  [${i.collection}] ${i.message}\n`);
    }
  }
  if (!report.ok) {
    process.stdout.write("\nFix the blockers, then re-run `vaultbase doctor`.\n");
    return 1;
  }
  process.stdout.write("\nWarnings are advisory — migration will proceed. Address them if the dropped data matters.\n");
  return 0;
}
