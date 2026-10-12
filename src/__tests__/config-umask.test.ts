/**
 * No umask was set, so with the usual 022 every file the server created —
 * database, uploads, logs, backups — was world-readable outside installs
 * made by the installer. loadConfig() now sets 027.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../config.ts";

describe("file permissions", () => {
  it.skipIf(process.platform === "win32")("data directories and new files aren't world-readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "vb-umask-"));
    const saved = { dir: process.env["VAULTBASE_DATA_DIR"], secret: process.env["VAULTBASE_JWT_SECRET"], mask: process.umask() };
    process.env["VAULTBASE_DATA_DIR"] = join(root, "data");
    process.env["VAULTBASE_JWT_SECRET"] = "x".repeat(32);
    process.umask(0o022);
    try {
      const config = await loadConfig();
      expect(statSync(config.dataDir).mode & 0o007).toBe(0);
      expect(statSync(config.uploadDir).mode & 0o007).toBe(0);
      const f = join(config.uploadDir, "probe.bin");
      writeFileSync(f, "x");
      expect(statSync(f).mode & 0o007).toBe(0);
      // The owner can still read and write (legitimate path).
      expect(statSync(f).mode & 0o600).toBe(0o600);
    } finally {
      process.umask(saved.mask);
      if (saved.dir === undefined) delete process.env["VAULTBASE_DATA_DIR"]; else process.env["VAULTBASE_DATA_DIR"] = saved.dir;
      if (saved.secret === undefined) delete process.env["VAULTBASE_JWT_SECRET"]; else process.env["VAULTBASE_JWT_SECRET"] = saved.secret;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
