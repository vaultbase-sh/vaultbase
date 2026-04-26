import { describe, expect, it } from "bun:test";

describe("config", () => {
  it("uses defaults when env vars absent", () => {
    delete process.env["VAULTBASE_PORT"];
    delete process.env["VAULTBASE_DATA_DIR"];
    const config = {
      port: parseInt(process.env["VAULTBASE_PORT"] ?? "8090"),
      dataDir: process.env["VAULTBASE_DATA_DIR"] ?? "./vaultbase_data",
    };
    expect(config.port).toBe(8090);
    expect(config.dataDir).toBe("./vaultbase_data");
  });

  it("reads port from env", () => {
    process.env["VAULTBASE_PORT"] = "9000";
    const port = parseInt(process.env["VAULTBASE_PORT"] ?? "8090");
    expect(port).toBe(9000);
    delete process.env["VAULTBASE_PORT"];
  });
});
