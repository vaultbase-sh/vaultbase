/**
 * Thumbnails (handoff Medium "Thumbnails"): the source was decoded with no
 * pixel budget — a small file can declare a huge canvas — and the per-file
 * variant cap was checked before generating and counted after, so
 * concurrent requests for different sizes all passed it.
 */
import { describe, expect, it } from "bun:test";
import { generateThumbnail, ImageTooLargeError, MAX_THUMB_VARIANTS, forgetThumbVariants, reserveThumbVariant } from "../core/image.ts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** A PNG whose header claims width × height, with no real pixel data. */
function pngClaiming(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, Bun.hash.crc32(body) >>> 0);
    return new Uint8Array([...len, ...body, ...crc]);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", ihdr), ...chunk("IEND", new Uint8Array())]);
}

describe("thumbnail decode budget", () => {
  it("a declared canvas over the budget isn't decoded", async () => {
    await expect(generateThumbnail(pngClaiming(9_000, 9_000), { width: 100, height: 100, fit: "contain" }, "png"))
      .rejects.toBeInstanceOf(ImageTooLargeError);
  });

  it("normal images still thumbnail (legitimate path)", async () => {
    const png = await new Bun.Image(pngClaiming(1, 1)).metadata().then(() => null).catch(() => null);
    void png;
    const src = await (async () => {
      // A real 64x64 PNG rendered by Bun.Image from raw RGBA.
      const { Image } = await import("imagescript");
      return new Uint8Array(await new Image(64, 64).fill(0xff0000ff).encode());
    })();
    const out = await generateThumbnail(src, { width: 16, height: 16, fit: "contain" }, "png");
    expect((await new Bun.Image(out).metadata()).width).toBe(16);
  });
});

describe("variant cap", () => {
  it("is taken atomically, so a burst can't exceed it", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-thumbcap-"));
    forgetThumbVariants();
    let granted = 0;
    for (let i = 0; i < MAX_THUMB_VARIANTS + 20; i++) if (reserveThumbVariant(dir, "f.png")) granted++;
    expect(granted).toBe(MAX_THUMB_VARIANTS);
    forgetThumbVariants();
  });
});
