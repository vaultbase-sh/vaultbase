/**
 * `vaultbase token <subcmd>` — local CLI for API-token management.
 *
 *   vaultbase token mint --name "CI bot" --scope write [--scope read] [--ttl 90d]
 *   vaultbase token list
 *   vaultbase token revoke <id>
 *
 * Bypasses HTTP — operates on the local DB directly. Useful for first-token
 * bootstrapping (before the admin UI is reachable from elsewhere) and for
 * cron jobs that rotate tokens without a web round-trip.
 */
import { eq } from "drizzle-orm";
import { initDb, getDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import {
  KNOWN_SCOPES,
  listApiTokens,
  mintApiToken,
  revokeApiToken,
} from "../core/api-tokens.ts";

interface ParsedArgs {
  name?: string;
  scopes: string[];
  ttlSeconds?: number;
  asEmail?: string;
  json: boolean;
}

function parseTtl(s: string): number | null {
  const m = /^(\d+)\s*([smhdy])?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1] ?? "0", 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "d").toLowerCase();
  const mult = unit === "s" ? 1
    : unit === "m" ? 60
    : unit === "h" ? 3600
    : unit === "y" ? 365 * 86400
    : 86400;
  return n * mult;
}

function parseFlags(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { scopes: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--name" || a === "-n") {
      const v = argv[++i];
      if (v) out.name = v;
    } else if (a.startsWith("--name=")) {
      out.name = a.slice("--name=".length);
    } else if (a === "--scope" || a === "-s") {
      const s = argv[++i] ?? "";
      if (s) out.scopes.push(s);
    } else if (a.startsWith("--scope=")) {
      out.scopes.push(a.slice("--scope=".length));
    } else if (a === "--ttl" || a === "-t") {
      const t = parseTtl(argv[++i] ?? "");
      if (t == null) throw new Error(`invalid --ttl (use 90d / 1y / 12h / 600s)`);
      out.ttlSeconds = t;
    } else if (a.startsWith("--ttl=")) {
      const t = parseTtl(a.slice("--ttl=".length));
      if (t == null) throw new Error(`invalid --ttl (use 90d / 1y / 12h / 600s)`);
      out.ttlSeconds = t;
    } else if (a === "--as" || a === "--admin") {
      const v = argv[++i];
      if (v) out.asEmail = v;
    } else if (a.startsWith("--as=")) {
      out.asEmail = a.slice("--as=".length);
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`Usage: vaultbase token <subcommand> [flags]

Subcommands:
  mint      Mint a new API token (returned ONCE — save it)
  list      List all API tokens (metadata only, never the token value)
  revoke    Revoke a token by id
  help      Show this help

Flags:
  --name, -n <string>      Token display name (required for mint)
  --scope, -s <string>     Scope to grant (repeatable). Known: ${KNOWN_SCOPES.join(", ")}
  --ttl, -t <duration>     Lifetime: 90d, 1y, 12h, 600s. Default 90d
  --as, --admin <email>    Mint as a specific admin (default: first admin in DB)
  --json                   Machine-readable JSON output

Examples:
  vaultbase token mint --name "CI bot" --scope write --scope read --ttl 1y
  vaultbase token list --json
  vaultbase token revoke 7f9a3c1d-...
`);
}

async function resolveAdmin(asEmail?: string): Promise<{ id: string; email: string }> {
  const db = getDb();
  const rows = asEmail
    ? await db.select().from(admin).where(eq(admin.email, asEmail)).limit(1)
    : await db.select().from(admin).limit(1);
  const row = rows[0];
  if (!row) throw new Error(asEmail ? `admin '${asEmail}' not found` : "no admin exists yet — create one via /_/setup or `vaultbase setup-admin` first");
  return { id: row.id, email: row.email };
}

async function cmdMint(args: ParsedArgs, jwtSecret: string): Promise<void> {
  if (!args.name) throw new Error("--name is required for mint");
  if (args.scopes.length === 0) throw new Error("at least one --scope is required");
  const minter = await resolveAdmin(args.asEmail);
  const result = await mintApiToken({
    name: args.name,
    scopes: args.scopes,
    ...(args.ttlSeconds !== undefined ? { ttlSeconds: args.ttlSeconds } : {}),
    createdBy: minter.id,
    createdByEmail: minter.email,
  }, jwtSecret);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    const expDate = new Date(result.expires_at * 1000).toISOString();
    process.stdout.write(`✓ minted as ${minter.email}\n`);
    process.stdout.write(`  id:      ${result.id}\n`);
    process.stdout.write(`  expires: ${expDate} (${Math.round((result.expires_at - Math.floor(Date.now() / 1000)) / 86400)} days)\n`);
    process.stdout.write(`  scopes:  ${args.scopes.join(", ")}\n\n`);
    process.stdout.write(`  TOKEN — save this, it will NEVER be shown again:\n\n`);
    process.stdout.write(`    ${result.token}\n\n`);
  }
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const rows = await listApiTokens();
  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("(no tokens minted yet)\n");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  process.stdout.write(`name                            scopes                  status      last used         id\n`);
  process.stdout.write(`──────────────────────────────  ──────────────────────  ──────────  ────────────────  ──────────────────────────────────────\n`);
  for (const r of rows) {
    const status = r.revoked_at ? "revoked"
      : r.expires_at < now ? "expired"
      : "active";
    const last = r.last_used_at ? new Date(r.last_used_at * 1000).toISOString().slice(0, 16) : "—";
    const name = r.name.length > 30 ? r.name.slice(0, 27) + "…" : r.name.padEnd(30);
    const scopes = r.scopes.join(",").length > 22 ? r.scopes.join(",").slice(0, 19) + "…" : r.scopes.join(",").padEnd(22);
    process.stdout.write(`${name}  ${scopes}  ${status.padEnd(10)}  ${last.padEnd(16)}  ${r.id}\n`);
  }
}

async function cmdRevoke(id: string, args: ParsedArgs): Promise<void> {
  if (!id) throw new Error("token id required: `vaultbase token revoke <id>`");
  const r = await revokeApiToken(id);
  if (!r.revoked) throw new Error(`token '${id}' not found`);
  if (args.json) process.stdout.write(JSON.stringify({ revoked: true, id }) + "\n");
  else process.stdout.write(`✓ revoked ${id}\n`);
}

export async function runTokenCli(argv: string[], dbPath: string, jwtSecret: string): Promise<void> {
  const sub = argv[0] ?? "";
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    printHelp();
    return;
  }

  initDb(`file:${dbPath}`);
  await runMigrations();
  try {
    if (sub === "mint") {
      const args = parseFlags(argv.slice(1));
      await cmdMint(args, jwtSecret);
    } else if (sub === "list" || sub === "ls") {
      const args = parseFlags(argv.slice(1));
      await cmdList(args);
    } else if (sub === "revoke" || sub === "rm") {
      const args = parseFlags(argv.slice(2));
      await cmdRevoke(argv[1] ?? "", args);
    } else {
      throw new Error(`unknown subcommand '${sub}' — try 'vaultbase token help'`);
    }
  } finally {
    closeDb();
  }
}
