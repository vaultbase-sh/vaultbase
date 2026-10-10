import { describe, expect, it } from "bun:test";
import { join } from "path";

const ENTRY = join(import.meta.dir, "../index.ts");

// One-shot CLI commands must exit on their own. A module-level timer without
// .unref() keeps the event loop alive and turns `vaultbase --help` into a hang.
async function runCli(args: string[], timeoutMs = 10_000) {
  const proc = Bun.spawn(["bun", ENTRY, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout: await new Response(proc.stdout).text(), killed: proc.signalCode !== null };
}

describe("cli one-shot commands exit", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  }, 15_000);

  it("--version prints the version and exits 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
  }, 15_000);
});
