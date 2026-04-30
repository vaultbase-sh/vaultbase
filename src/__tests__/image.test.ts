import { describe, expect, it } from "bun:test";
import { detectFormat, parseThumbSpec } from "../core/image.ts";

describe("parseThumbSpec", () => {
  it.each([
    ["100x100", { width: 100, height: 100, fit: "contain" as const }],
    ["1x1",     { width: 1,   height: 1,   fit: "contain" as const }],
    ["64x96",   { width: 64,  height: 96,  fit: "contain" as const }],
    ["4096x4096", { width: 4096, height: 4096, fit: "contain" as const }],
  ])("accepts %s", (input, expected) => {
    expect(parseThumbSpec(input)).toEqual(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["100"],
    ["100x"],
    ["x100"],
    ["100x0"],
    ["0x100"],
    ["100x4097"],   // exceeds MAX_DIM
    ["100x100x100"],
    ["abc x 100"],
    ["-50x50"],
    ["50.5x50"],
  ])("rejects %p", (input) => {
    expect(parseThumbSpec(input)).toBeNull();
  });
});

describe("detectFormat", () => {
  it("recognizes PNG", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectFormat(png)).toBe("png");
  });

  it("recognizes JPEG", () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(detectFormat(jpg)).toBe("jpeg");
  });

  it.each([
    ["GIF87a", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0, 0])],
    ["GIF89a", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])],
  ])("recognizes %s", (_label, bytes) => {
    expect(detectFormat(bytes)).toBe("gif");
  });

  it("returns null for non-images and short buffers", () => {
    expect(detectFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBeNull(); // too short
  });
});
