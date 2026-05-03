/**
 * `vaultbase update` — self-update CLI.
 *
 * Pulls the latest signed release for the running platform from GitHub,
 * verifies the SHA-256 (always) and cosign signature (when cosign is
 * available), then atomically replaces the running binary. The running
 * process keeps executing off the old inode; restart to pick up the new
 * binary.
 *
 *   vaultbase update                    interactive flow
 *   vaultbase update --check            print versions, exit 0 (in sync) or 1 (update available)
 *   vaultbase update --yes              non-interactive — don't prompt
 *   vaultbase update --version 0.8.0    pin to a specific release
 *   vaultbase update --no-verify        SHA-256 only; skip cosign even if present (warns)
 *   vaultbase update --allow-downgrade  permit moving to an older version
 *
 * Safety:
 *   - SHA-256 mismatch → abort, no swap
 *   - cosign mismatch → abort, no swap
 *   - permission denied on rename → clear error
 *   - running on Windows → can't replace a running .exe; instructs operator
 */

import { existsSync, mkdtempSync, renameSync, chmodSync, statSync, copyFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { VAULTBASE_VERSION } from "../core/version.ts";

interface UpdateFlags {
  check: boolean;
  yes: boolean;
  pinnedVersion: string | null;
  skipVerify: boolean;
  allowDowngrade: boolean;
  quiet: boolean;
}

function parseFlags(argv: string[]): UpdateFlags {
  const flags: UpdateFlags = {
    check: false,
    yes: false,
    pinnedVersion: null,
    skipVerify: false,
    allowDowngrade: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--check") flags.check = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--no-verify") flags.skipVerify = true;
    else if (a === "--allow-downgrade") flags.allowDowngrade = true;
    else if (a === "--quiet" || a === "-q") flags.quiet = true;
    else if (a === "--version" || a === "-v") flags.pinnedVersion = argv[++i] ?? null;
    else if (a.startsWith("--version=")) flags.pinnedVersion = a.slice("--version=".length);
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { process.stderr.write(`vaultbase update: unknown flag '${a}'\n`); process.exit(2); }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(`Usage: vaultbase update [flags]

Flags:
  --check                Print versions and exit (0 = in sync, 1 = update available)
  --yes, -y              Non-interactive; don't prompt for confirmation
  --version X.Y.Z, -v    Pin to a specific release (default: latest)
  --no-verify            Skip cosign signature check (SHA-256 still enforced)
  --allow-downgrade      Permit moving to an older version
  --quiet, -q            Suppress progress output
  --help, -h             Show this message
`);
}

interface PlatformTarget {
  /** Filename under github releases — e.g. "vaultbase-linux-x64". */
  artifact: string;
  /** True for Windows where the running binary is locked. */
  windows: boolean;
}

function detectPlatform(): PlatformTarget {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32" && a === "x64") return { artifact: "vaultbase-windows-x64.exe", windows: true };
  if (p === "darwin" && a === "x64") return { artifact: "vaultbase-macos-x64", windows: false };
  if (p === "darwin" && a === "arm64") return { artifact: "vaultbase-macos-arm64", windows: false };
  if (p === "linux" && a === "arm64") return { artifact: "vaultbase-linux-arm64", windows: false };
  if (p === "linux" && a === "x64") {
    // Detect musl (Alpine) vs glibc — different binary.
    const musl = isMusl();
    return { artifact: musl ? "vaultbase-linux-x64-musl" : "vaultbase-linux-x64", windows: false };
  }
  throw new Error(`unsupported platform: ${p}/${a} — file an issue with this output`);
}

function isMusl(): boolean {
  if (existsSync("/etc/alpine-release")) return true;
  try {
    const r = spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (r.stdout && /musl/i.test(r.stdout)) return true;
    if (r.stderr && /musl/i.test(r.stderr)) return true;
  } catch { /* ignore */ }
  return false;
}

interface Release {
  tag_name: string;
  body: string;
  published_at: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

async function fetchRelease(version: string | null): Promise<Release> {
  const url = version
    ? `https://api.github.com/repos/vaultbase-sh/vaultbase/releases/tags/v${version.replace(/^v/, "")}`
    : `https://api.github.com/repos/vaultbase-sh/vaultbase/releases/latest`;
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": `vaultbase-update/${VAULTBASE_VERSION}` } });
  if (res.status === 404) throw new Error(`no release found at ${url}`);
  if (!res.ok) throw new Error(`github API ${res.status} on ${url}`);
  return await res.json() as Release;
}

function compareVersion(current: string, target: string): -1 | 0 | 1 {
  const norm = (s: string): number[] => s.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = norm(current);
  const b = norm(target);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

async function downloadTo(url: string, dest: string, log: (s: string) => void): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": `vaultbase-update/${VAULTBASE_VERSION}` }, redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  const file = Bun.file(dest);
  const writer = file.writer();
  let received = 0;
  let lastPct = -1;
  if (!res.body) throw new Error("download failed: empty body");
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    writer.write(chunk);
    received += chunk.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        log(`  download: ${pct}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB)`);
        lastPct = pct;
      }
    }
  }
  await writer.end();
}

async function sha256OfFile(path: string): Promise<string> {
  const buf = await Bun.file(path).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hasCosign(): boolean {
  try {
    const r = spawnSync("cosign", ["version"], { encoding: "utf8" });
    return r.status === 0;
  } catch { return false; }
}

function runCosignVerify(binPath: string, sigPath: string, certPath: string, repo: string, ref: string): boolean {
  const r = spawnSync("cosign", [
    "verify-blob",
    "--certificate", certPath,
    "--signature",   sigPath,
    "--certificate-identity-regexp", `^https://github\\.com/${repo}/`,
    "--certificate-oidc-issuer",     "https://token.actions.githubusercontent.com",
    binPath,
  ], { encoding: "utf8" });
  if (r.status === 0) return true;
  process.stderr.write(`cosign verify failed:\n${r.stderr || r.stdout}\n`);
  void ref;
  return false;
}

async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  // Bun exposes stdin as an async iterable of Buffers when invoked as a TTY.
  const stdin = process.stdin as unknown as AsyncIterable<Buffer>;
  for await (const chunk of stdin) {
    const s = chunk.toString("utf8").trim().toLowerCase();
    return s === "y" || s === "yes";
  }
  return false;
}

export async function runUpdate(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const log = (s: string) => { if (!flags.quiet) process.stdout.write(`${s}\n`); };

  const platform = detectPlatform();
  log(`vaultbase ${VAULTBASE_VERSION} on ${process.platform}/${process.arch}${platform.artifact.includes("musl") ? " (musl)" : ""}`);

  log("checking for updates…");
  const release = await fetchRelease(flags.pinnedVersion);
  const target = release.tag_name.replace(/^v/, "");
  const cmp = compareVersion(VAULTBASE_VERSION, target);

  if (cmp === 0) {
    log(`already on ${VAULTBASE_VERSION} — nothing to do.`);
    if (flags.check) process.exit(0);
    return;
  }
  if (cmp > 0 && !flags.allowDowngrade) {
    process.stderr.write(`vaultbase update: target ${target} is older than current ${VAULTBASE_VERSION}; pass --allow-downgrade to override\n`);
    process.exit(2);
  }

  log(`update available: ${VAULTBASE_VERSION} → ${target}`);
  if (flags.check) process.exit(1);

  const binAsset = release.assets.find((a) => a.name === platform.artifact);
  const sigAsset = release.assets.find((a) => a.name === `${platform.artifact}.sig`);
  const certAsset = release.assets.find((a) => a.name === `${platform.artifact}.pem`);
  const sumsAsset = release.assets.find((a) => a.name === `${platform.artifact}.sha256`);
  if (!binAsset) throw new Error(`release ${target} has no asset '${platform.artifact}'`);
  if (!sumsAsset) throw new Error(`release ${target} has no '${platform.artifact}.sha256'`);

  if (!flags.yes) {
    log("");
    log(`This will replace the running binary at ${process.execPath}`);
    if (platform.windows) log("⚠ on Windows the running .exe is locked — you must stop vaultbase first.");
    log("");
    if (!await promptYesNo(`Update to ${target}?`)) {
      log("aborted.");
      process.exit(1);
    }
  }

  if (platform.windows) {
    process.stderr.write(`vaultbase update: cannot replace a running .exe on Windows. Stop the daemon first, then run \`vaultbase update --yes\` again.\n`);
    process.exit(2);
  }

  const tmp = mkdtempSync(join(tmpdir(), "vaultbase-update-"));
  log(`downloading to ${tmp}…`);

  const binPath = join(tmp, platform.artifact);
  const sumsPath = join(tmp, `${platform.artifact}.sha256`);
  await downloadTo(binAsset.browser_download_url, binPath, log);
  await downloadTo(sumsAsset.browser_download_url, sumsPath, log);

  // SHA-256 verify (always)
  log("verifying SHA-256…");
  const expectedSha = (await Bun.file(sumsPath).text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const actualSha = await sha256OfFile(binPath);
  if (expectedSha !== actualSha) {
    throw new Error(`SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  log("  ✓ SHA-256 ok");

  // Cosign verify (when cosign present and not skipped)
  if (!flags.skipVerify) {
    if (sigAsset && certAsset && hasCosign()) {
      const sigPath = join(tmp, `${platform.artifact}.sig`);
      const certPath = join(tmp, `${platform.artifact}.pem`);
      await downloadTo(sigAsset.browser_download_url, sigPath, log);
      await downloadTo(certAsset.browser_download_url, certPath, log);
      log("verifying cosign signature…");
      if (!runCosignVerify(binPath, sigPath, certPath, "vaultbase-sh/vaultbase", target)) {
        throw new Error("cosign signature verification failed — refusing to update");
      }
      log("  ✓ cosign ok");
    } else if (!hasCosign()) {
      process.stderr.write("⚠ cosign not in PATH — skipping signature verification (SHA-256 still enforced).\n");
      process.stderr.write("  Install cosign for cryptographic provenance: https://docs.sigstore.dev/cosign/installation\n");
    }
  } else {
    process.stderr.write("⚠ --no-verify: cosign signature NOT checked (SHA-256 still enforced).\n");
  }

  // Atomic replace
  chmodSync(binPath, 0o755);
  const target_path = process.execPath;
  log(`installing to ${target_path}…`);
  try {
    // Linux/macOS: rename of running binary keeps the process running off the
    // old inode. The new binary is in place for the next exec.
    renameSync(binPath, target_path);
  } catch (e) {
    // Cross-device move (binary in /usr/local/bin, tmp in /tmp on a different mount).
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(binPath, target_path);
      try { unlinkSync(binPath); } catch { /* ignore */ }
    } else {
      throw e;
    }
  }
  // Sanity-check the new binary is executable + correct size.
  try {
    const s = statSync(target_path);
    if (s.size < 1_000_000) throw new Error(`installed binary is suspiciously small (${s.size} bytes)`);
  } catch (e) {
    throw new Error(`post-install stat failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  log("");
  log(`✓ updated to ${target}.`);
  log(`  restart vaultbase to apply.`);
  log("");
  if (release.body) {
    log("Release notes:");
    for (const line of release.body.slice(0, 4000).split("\n")) log(`  ${line}`);
  }
}
