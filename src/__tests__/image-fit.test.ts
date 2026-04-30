import { describe, expect, it } from "bun:test";
import { Image } from "imagescript";
import {
  generateThumbnail,
  parseThumbSpec,
  thumbCachePath,
  type ThumbSpec,
} from "../core/image.ts";

// ── parseThumbSpec ──────────────────────────────────────────────────────────

describe("parseThumbSpec — fit modes", () => {
  it("defaults to contain when fit is omitted", () => {
    expect(parseThumbSpec("100x100")).toEqual({ width: 100, height: 100, fit: "contain" });
  });

  it.each([
    ["100x100&fit=contain", "contain"],
    ["100x100&fit=cover",   "cover"],
    ["100x100&fit=crop",    "crop"],
  ])("accepts &fit= form: %s", (input, fit) => {
    expect(parseThumbSpec(input)).toEqual({ width: 100, height: 100, fit: fit as ThumbSpec["fit"] });
  });

  it.each([
    ["200x200_contain", "contain"],
    ["200x200_cover",   "cover"],
    ["200x200_crop",    "crop"],
  ])("accepts hyphenated form: %s", (input, fit) => {
    expect(parseThumbSpec(input)).toEqual({ width: 200, height: 200, fit: fit as ThumbSpec["fit"] });
  });

  it.each([
    ["100x100&fit=stretch"],
    ["100x100&fit="],
    ["100x100_stretch"],
    ["100x100_cover&fit=contain"], // can't combine
  ])("rejects malformed fit: %p", (input) => {
    expect(parseThumbSpec(input)).toBeNull();
  });
});

// ── thumbCachePath ──────────────────────────────────────────────────────────

describe("thumbCachePath — fit-aware cache key", () => {
  it("contain keeps the legacy filename shape (no suffix)", () => {
    const p = thumbCachePath("/tmp/uploads", "abc.png", { width: 100, height: 100, fit: "contain" });
    expect(p.endsWith("abc.png__100x100")).toBe(true);
  });

  it("cover uses a distinct suffix", () => {
    const p = thumbCachePath("/tmp/uploads", "abc.png", { width: 100, height: 100, fit: "cover" });
    expect(p.endsWith("abc.png__100x100_cover")).toBe(true);
  });

  it("crop and cover share a cache entry (alias)", () => {
    const a = thumbCachePath("/tmp/uploads", "abc.png", { width: 100, height: 100, fit: "cover" });
    const b = thumbCachePath("/tmp/uploads", "abc.png", { width: 100, height: 100, fit: "crop" });
    expect(a).toBe(b);
  });

  it("contain and cover do NOT collide", () => {
    const a = thumbCachePath("/tmp/uploads", "abc.png", { width: 100, height: 100, fit: "contain" });
    const b = thumbCachePath("/tmp/uploads", "abc.png", { width: 100, height: 100, fit: "cover" });
    expect(a).not.toBe(b);
  });
});

// ── generateThumbnail — output dimensions per fit mode ─────────────────────

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const img = new Image(width, height);
  // Solid mid-gray so encoding produces real bytes. Use compression level 1 —
  // imagescript's PNG encoder mis-emits a stream at level 0 that its own
  // decoder cannot read back at non-trivial sizes.
  img.fill(Image.rgbaToColor(128, 128, 128, 255));
  return await img.encode(1);
}

describe("generateThumbnail — fit dimensions", () => {
  it("contain on 400x200 → 100x100 produces 100x50 (preserves aspect)", async () => {
    const src = await makePng(400, 200);
    const out = await generateThumbnail(src, { width: 100, height: 100, fit: "contain" }, "png");
    const decoded = await Image.decode(out);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(50);
  });

  it("cover on 400x200 → 100x100 produces exactly 100x100", async () => {
    const src = await makePng(400, 200);
    const out = await generateThumbnail(src, { width: 100, height: 100, fit: "cover" }, "png");
    const decoded = await Image.decode(out);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(100);
  });

  it("crop is identical to cover (alias) — exact 100x100", async () => {
    const src = await makePng(400, 200);
    const out = await generateThumbnail(src, { width: 100, height: 100, fit: "crop" }, "png");
    const decoded = await Image.decode(out);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(100);
  });

  it("contain on a tall source (200x400) → 100x100 produces 50x100", async () => {
    const src = await makePng(200, 400);
    const out = await generateThumbnail(src, { width: 100, height: 100, fit: "contain" }, "png");
    const decoded = await Image.decode(out);
    expect(decoded.width).toBe(50);
    expect(decoded.height).toBe(100);
  });

  it("cover on a tall source (200x400) → 100x100 still produces exactly 100x100", async () => {
    const src = await makePng(200, 400);
    const out = await generateThumbnail(src, { width: 100, height: 100, fit: "cover" }, "png");
    const decoded = await Image.decode(out);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(100);
  });
});
