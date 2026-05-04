/**
 * `vaultbase wipe` — verifies the script:
 *   - dry-runs by default (no --yes)
 *   - refuses on production signals (NODE_ENV=production etc.)
 *   - actually deletes when --yes is passed
 *   - --force overrides the production refusal
 *
 * Hits real fs paths under a tmp dir; never touches the real
 * vaultbase install.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runWipeCli } from "../scripts/wipe.ts";

let dataDir: string;
let stdout: string[];
let stderr: string[];
let origNodeEnv: string | undefined;
let origVbEnv: string | undefined;
let origK8s: string | undefined;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

function captureStdio(): void {
  stdout = []; stderr = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — narrow override for the test
  process.stdout.write = (chunk: string) => { stdout.push(typeof chunk === "string" ? chunk : String(chunk)); return true; };
  // @ts-expect-error — narrow override for the test
  process.stderr.write = (chunk: string) => { stderr.push(typeof chunk === "string" ? chunk : String(chunk)); return true; };
}

function restoreStdio(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

function seedDataDir(): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "data.db"), "fake-sqlite-bytes");
  writeFileSync(join(dataDir, "data.db-wal"), "wal");
  writeFileSync(join(dataDir, ".secret"), "jwt-secret-bytes");
  writeFileSync(join(dataDir, ".encryption-key"), "key");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  writeFileSync(join(dataDir, "uploads", "x.png"), "image-bytes");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  writeFileSync(join(dataDir, "logs", "2026-05-04.log"), "{}");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vaultbase-wipe-test-"));
  origNodeEnv = process.env["NODE_ENV"];
  origVbEnv = process.env["VAULTBASE_ENV"];
  origK8s = process.env["KUBERNETES_SERVICE_HOST"];
  delete process.env["NODE_ENV"];
  delete process.env["VAULTBASE_ENV"];
  delete process.env["KUBERNETES_SERVICE_HOST"];
});

afterEach(() => {
  restoreStdio();
  if (origNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = origNodeEnv;
  if (origVbEnv === undefined) delete process.env["VAULTBASE_ENV"];
  else process.env["VAULTBASE_ENV"] = origVbEnv;
  if (origK8s === undefined) delete process.env["KUBERNETES_SERVICE_HOST"];
  else process.env["KUBERNETES_SERVICE_HOST"] = origK8s;
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* swallow */ }
});

describe("vaultbase wipe", () => {
  it("dry-run reports targets but doesn't delete", () => {
    seedDataDir();
    captureStdio();
    const code = runWipeCli([], dataDir);
    restoreStdio();
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Dry run");
    expect(existsSync(join(dataDir, "data.db"))).toBe(true);
    expect(existsSync(join(dataDir, ".secret"))).toBe(true);
  });

  it("--yes deletes everything in a non-prod env", () => {
    seedDataDir();
    captureStdio();
    const code = runWipeCli(["--yes"], dataDir);
    restoreStdio();
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Wipe complete");
    expect(existsSync(join(dataDir, "data.db"))).toBe(false);
    expect(existsSync(join(dataDir, ".secret"))).toBe(false);
    expect(existsSync(join(dataDir, "uploads"))).toBe(false);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
  });

  it("refuses --yes when NODE_ENV=production (no --force)", () => {
    seedDataDir();
    process.env["NODE_ENV"] = "production";
    captureStdio();
    const code = runWipeCli(["--yes"], dataDir);
    restoreStdio();
    expect(code).toBe(2);
    expect(stdout.join("")).toContain("PRODUCTION SIGNALS");
    expect(stdout.join("")).toContain("Refusing");
    // Files preserved.
    expect(existsSync(join(dataDir, "data.db"))).toBe(true);
  });

  it("refuses --yes when VAULTBASE_ENV=prod (no --force)", () => {
    seedDataDir();
    process.env["VAULTBASE_ENV"] = "prod";
    captureStdio();
    const code = runWipeCli(["--yes"], dataDir);
    restoreStdio();
    expect(code).toBe(2);
    expect(existsSync(join(dataDir, "data.db"))).toBe(true);
  });

  it("refuses --yes inside a Kubernetes pod (no --force)", () => {
    seedDataDir();
    process.env["KUBERNETES_SERVICE_HOST"] = "10.0.0.1";
    captureStdio();
    const code = runWipeCli(["--yes"], dataDir);
    restoreStdio();
    expect(code).toBe(2);
    expect(existsSync(join(dataDir, "data.db"))).toBe(true);
  });

  it("--yes --force wipes even when production signals present", () => {
    seedDataDir();
    process.env["NODE_ENV"] = "production";
    captureStdio();
    const code = runWipeCli(["--yes", "--force"], dataDir);
    restoreStdio();
    expect(code).toBe(0);
    expect(existsSync(join(dataDir, "data.db"))).toBe(false);
  });

  it("returns 0 when dataDir doesn't exist (nothing to wipe)", () => {
    rmSync(dataDir, { recursive: true, force: true });
    captureStdio();
    const code = runWipeCli(["--yes"], dataDir);
    restoreStdio();
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("nothing to wipe");
  });

  it("--help prints usage", () => {
    captureStdio();
    const code = runWipeCli(["--help"], dataDir);
    restoreStdio();
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Usage: vaultbase wipe");
  });
});
