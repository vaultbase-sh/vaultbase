import { describe, expect, it } from "bun:test";
import { Image, GIF } from "imagescript";
import { GIFEncoder, applyPalette, quantize } from "gifenc";

import {
  canThumbnail,
  detectFormat,
  generateThumbnail,
  thumbMime,
  type ThumbFormat,
} from "../core/image.ts";

// ── helpers ────────────────────────────────────────────────────────────────

/** ImageData-shaped literal — DOM lib isn't loaded so we declare structurally. */
interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace?: string;
}

function solidImageData(w: number, h: number, r: number, g: number, b: number): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, colorSpace: "srgb" };
}

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const img = new Image(width, height);
  img.fill(Image.rgbaToColor(128, 128, 128, 255));
  // Compression level 1 — level 0 emits a stream imagescript can't read back.
  return await img.encode(1);
}

/** Re-encode a PNG fixture into another format with Bun's native codecs. */
async function convert(png: Uint8Array, format: "jpeg" | "webp"): Promise<Uint8Array> {
  const img = new Bun.Image(png);
  return format === "jpeg" ? await img.jpeg({ quality: 90 }).bytes() : await img.webp().bytes();
}

async function dims(bytes: Uint8Array): Promise<string> {
  const m = await new Bun.Image(bytes).metadata();
  return `${m.width}x${m.height}`;
}

/** Minimal ISO-BMFF header with the `avif` major brand — enough for sniffing. */
function avifHeader(): Uint8Array {
  const buf = new Uint8Array(32);
  buf.set([0, 0, 0, 0x20], 0);
  buf.set([0x66, 0x74, 0x79, 0x70], 4);          // "ftyp"
  buf.set([0x61, 0x76, 0x69, 0x66], 8);          // "avif"
  return buf;
}

// ── detectFormat: WebP / AVIF magic bytes ─────────────────────────────────

describe("detectFormat — webp + avif", () => {
  it("recognizes a real WebP buffer", async () => {
    expect(detectFormat(await convert(await makePng(8, 8), "webp"))).toBe("webp");
  });

  it("recognizes an AVIF header", () => {
    expect(detectFormat(avifHeader())).toBe("avif");
  });

  it("rejects RIFF without WEBP fourcc", () => {
    const buf = new Uint8Array(16);
    buf.set([0x52, 0x49, 0x46, 0x46], 0);          // "RIFF"
    buf.set([0x57, 0x41, 0x56, 0x45], 8);          // "WAVE", not WEBP
    expect(detectFormat(buf)).toBeNull();
  });

  it("rejects ftyp without 'avif' major brand", () => {
    const buf = new Uint8Array(16);
    buf.set([0, 0, 0, 0x20], 0);
    buf.set([0x66, 0x74, 0x79, 0x70], 4);          // "ftyp"
    buf.set([0x69, 0x73, 0x6f, 0x6d], 8);          // "isom"
    expect(detectFormat(buf)).toBeNull();
  });
});

describe("thumbMime", () => {
  it.each<[ThumbFormat, string]>([
    ["jpeg", "image/jpeg"],
    ["png",  "image/png"],
    ["gif",  "image/gif"],
    ["webp", "image/webp"],
    ["avif", "image/avif"],
  ])("maps %s → %s", (fmt, mime) => {
    expect(thumbMime(fmt)).toBe(mime);
  });
});

// ── AVIF: served as the original ──────────────────────────────────────────

describe("AVIF", () => {
  it("is not thumbnailed", async () => {
    expect(canThumbnail("avif")).toBe(false);
    await expect(generateThumbnail(avifHeader(), { width: 16, height: 16, fit: "contain" }, "avif")).rejects.toThrow();
  });

  it("every other format is", () => {
    for (const f of ["jpeg", "png", "gif", "webp"] as const) expect(canThumbnail(f)).toBe(true);
  });
});

// ── WebP end-to-end ────────────────────────────────────────────────────────

describe("generateThumbnail — WebP", () => {
  it("decodes a 200x200 source, resizes to 50x50, emits valid WebP", async () => {
    const src = await convert(await makePng(200, 200), "webp");
    const thumb = await generateThumbnail(src, { width: 50, height: 50, fit: "contain" }, "webp");
    expect(detectFormat(thumb)).toBe("webp");
    expect(await dims(thumb)).toBe("50x50");
  });

  it("cover fit produces exact target dims for non-square source", async () => {
    const src = await convert(await makePng(120, 60), "webp");
    const thumb = await generateThumbnail(src, { width: 40, height: 40, fit: "cover" }, "webp");
    expect(detectFormat(thumb)).toBe("webp");
    expect(await dims(thumb)).toBe("40x40");
  });
});

// ── PNG end-to-end ────────────────────────────────────────────────────────

describe("generateThumbnail — PNG", () => {
  it("emits a compressed PNG that decodes back at the contain dims", async () => {
    const src = await makePng(200, 100);
    const thumb = await generateThumbnail(src, { width: 50, height: 50, fit: "contain" }, "png");
    expect(detectFormat(thumb)).toBe("png");
    const decoded = await Image.decode(thumb);
    expect(decoded.width).toBe(50);
    expect(decoded.height).toBe(25);
    // Stored-only PNG would be ≥ 50*25*4 bytes of raw pixels.
    expect(thumb.byteLength).toBeLessThan(50 * 25 * 4);
  });
});

// ── JPEG end-to-end ───────────────────────────────────────────────────────

describe("generateThumbnail — JPEG", () => {
  it("decodes a 200x100 source, resizes to 50x25, emits valid JPEG", async () => {
    const src = await convert(await makePng(200, 100), "jpeg");
    expect(detectFormat(src)).toBe("jpeg");
    const thumb = await generateThumbnail(src, { width: 50, height: 50, fit: "contain" }, "jpeg");
    expect(detectFormat(thumb)).toBe("jpeg");
    expect(await dims(thumb)).toBe("50x25");
  });

  it("cover fit crops a landscape source to an exact square", async () => {
    const src = await convert(await makePng(300, 100), "jpeg");
    const thumb = await generateThumbnail(src, { width: 60, height: 60, fit: "cover" }, "jpeg");
    expect(detectFormat(thumb)).toBe("jpeg");
    expect(await dims(thumb)).toBe("60x60");
  });

  it("applies EXIF orientation, so a rotated phone photo keeps its shape", async () => {
    // 400x200 pixels tagged Orientation=6 (rotate 90° CW) → displays as 200x400.
    const base = await convert(await makePng(400, 200), "jpeg");
    const tiff = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    const payload = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
    const len = payload.length + 2;
    const src = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...payload, ...base.slice(2)]);
    const thumb = await generateThumbnail(src, { width: 100, height: 100, fit: "contain" }, "jpeg");
    expect(await dims(thumb)).toBe("50x100");
  });
});

// ── Animated GIF ──────────────────────────────────────────────────────────

/**
 * Build a GIF from solid-colour frames. imagescript's own GIF encoder is a
 * native addon that the single-binary build stubs out, so use gifenc.
 */
function makeGif(width: number, height: number, colors: Array<[number, number, number]>): Uint8Array {
  const enc = GIFEncoder();
  for (const [r, g, b] of colors) {
    const rgba = solidImageData(width, height, r, g, b).data;
    const palette = quantize(rgba, 256);
    enc.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay: 100 });
  }
  enc.finish();
  return enc.bytes();
}

async function makeAnimatedGif(): Promise<Uint8Array> {
  // Two 60x60 frames: solid red, then solid green; 100ms each.
  return makeGif(60, 60, [[255, 0, 0], [0, 255, 0]]);
}

describe("generateThumbnail — animated GIF", () => {
  it("preserves multi-frame structure when thumbnailing an animated source", async () => {
    const src = await makeAnimatedGif();
    expect(detectFormat(src)).toBe("gif");

    const thumb = await generateThumbnail(src, { width: 30, height: 30, fit: "contain" }, "gif");
    expect(thumb.byteLength).toBeGreaterThan(0);

    // Output should still be a GIF and still have ≥ 2 frames.
    expect(detectFormat(thumb)).toBe("gif");
    const decoded = await GIF.decode(thumb);
    expect(decoded.length).toBeGreaterThanOrEqual(2);
    // Frames are scaled to the contain box — square source → exact match.
    expect(decoded[0]!.width).toBe(30);
    expect(decoded[0]!.height).toBe(30);
  }, 30_000);
});

// ── Static GIF — existing behavior preserved ──────────────────────────────

describe("generateThumbnail — static GIF", () => {
  it("returns non-empty bytes that respect contain dims (downgrade to PNG is fine)", async () => {
    // Single-frame "GIF" — a plain PNG converted via a 1-frame GIF.
    const src = makeGif(80, 40, [[50, 50, 200]]);
    expect(detectFormat(src)).toBe("gif");

    const thumb = await generateThumbnail(src, { width: 20, height: 20, fit: "contain" }, "gif");
    expect(thumb.byteLength).toBeGreaterThan(0);

    // Whether the output is a 1-frame GIF or a PNG, it must decode to 20x10
    // (contain on 80x40 → 20x10).
    const fmt = detectFormat(thumb);
    expect(fmt === "png" || fmt === "gif").toBe(true);
    if (fmt === "gif") {
      const g = await GIF.decode(thumb);
      expect(g[0]!.width).toBe(20);
      expect(g[0]!.height).toBe(10);
    } else {
      const decoded = await Image.decode(thumb);
      expect(decoded.width).toBe(20);
      expect(decoded.height).toBe(10);
    }
  });

  it("makePng helper still works end-to-end (sanity)", async () => {
    const src = await makePng(40, 40);
    const out = await generateThumbnail(src, { width: 20, height: 20, fit: "contain" }, "png");
    const decoded = await Image.decode(out);
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(20);
  });
});
