// Runs from the Husky pre-push hook. Git passes one line per pushed ref on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// Skip it once with `git push --no-verify`.
import { checkMessage } from "./commit-msg.ts";

const ZERO = /^0+$/;

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

function run(label: string, cmd: string[], cwd = "."): void {
  console.log(`\npre-push: ${label}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) fail(`${label} failed`);
}

function fail(msg: string): never {
  console.error(`\npre-push: ${msg}. Push stopped.`);
  process.exit(1);
}

const refs = (await new Response(Bun.stdin.stream()).text())
  .split("\n").map((l) => l.trim().split(" ")).filter((p) => p.length === 4)
  .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }))
  .filter((r) => !ZERO.test(r.localSha!)); // deletions need no checks
if (refs.length === 0) process.exit(0);

// ── Commits about to leave this machine ──────────────────────────────────────
const outgoing = new Set<string>();
for (const r of refs) {
  const range = ZERO.test(r.remoteSha!) ? [r.localSha!, "--not", "--remotes"] : [`${r.remoteSha}..${r.localSha}`];
  const list = git("rev-list", ...range);
  for (const sha of list ? list.split("\n") : []) outgoing.add(sha);
}
for (const sha of outgoing) {
  const problem = checkMessage(git("log", "-1", "--format=%B", sha));
  if (problem) fail(`commit ${sha.slice(0, 7)} ${problem}`);
}

// ── Tags: the release checklist in HANDOFF.md ────────────────────────────────
for (const r of refs.filter((r) => r.remoteRef!.startsWith("refs/tags/v"))) {
  const tag = r.remoteRef!.slice("refs/tags/".length);
  const version = tag.slice(1);
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`tag ${tag} is not vX.Y.Z`);
  if (git("cat-file", "-t", r.localSha!) !== "tag") fail(`${tag} must be an annotated tag (git tag -a ${tag} -m ${tag})`);
  const commit = git("rev-list", "-n", "1", tag);
  const show = (path: string) => { try { return git("show", `${commit}:${path}`); } catch { return null; } };
  const expect: [string, (s: string) => boolean][] = [
    ["package.json", (s) => JSON.parse(s).version === version],
    ["admin/package.json", (s) => JSON.parse(s).version === version],
    ["src/core/version.ts", (s) => s.includes(`VAULTBASE_VERSION = "${version}"`)],
    ["deploy/README.md", (s) => s.includes(`-Version ${tag}`)],
    ["deploy/install.ps1", (s) => s.includes(`-Version ${tag}`)],
    ["CHANGELOG.md", (s) => s.includes(`## [${version}]`)],
    [`release-notes/${tag}.md`, (s) => s.trim().length > 0],
  ];
  const wrong = expect.filter(([path, ok]) => { const s = show(path); return s === null || !ok(s); }).map(([p]) => p);
  if (wrong.length) fail(`${tag}: version not updated in ${wrong.join(", ")} (see the release checklist in HANDOFF.md)`);
  console.log(`pre-push: ${tag} release files OK`);
}

// ── Build checks, as CI runs them ────────────────────────────────────────────
if (outgoing.size === 0) process.exit(0); // only tags on already-pushed commits
if (git("status", "--porcelain", "--untracked-files=no")) fail("the working tree has uncommitted changes, so the checks wouldn't test what you push. Commit or stash them");

const changed = new Set<string>();
for (const sha of outgoing) for (const f of git("show", "--name-only", "--format=", sha).split("\n")) if (f) changed.add(f);
const touches = (prefix: string) => [...changed].some((f) => f.startsWith(prefix));

run("typecheck", ["bun", "run", "typecheck"]);
run("tests", ["bun", "test"]);
if (touches("admin/") || touches("package.json") || touches("bun.lock")) {
  run("admin build", ["bun", "run", "build"], "admin");
} else {
  console.log("\npre-push: admin build skipped (admin/ unchanged)");
}
if (touches("src/") && !touches("CHANGELOG.md")) {
  console.log("\npre-push: note: src/ changed but CHANGELOG.md didn't. Add an [Unreleased] entry if users would notice.");
}
console.log("\npre-push: all checks passed");
