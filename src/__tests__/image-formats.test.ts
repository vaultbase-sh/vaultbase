import { describe, expect, it } from "bun:test";
import { Image, GIF, Frame } from "imagescript";
import { decode as webpDecode, encode as webpEncode } from "@jsquash/webp";
import { decode as avifDecode, encode as avifEncode } from "@jsquash/avif";

import {
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
  // Plain literal — both jsquash and our pipeline only read .data/.width/.height.
  return { data, width: w, height: h, colorSpace: "srgb" };
}

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const img = new Image(width, height);
  img.fill(Image.rgbaToColor(128, 128, 128, 255));
  // Compression level 1 — level 0 emits a stream imagescript can't read back.
  return await img.encode(1);
}

// ── detectFormat: WebP / AVIF magic bytes ─────────────────────────────────

describe("detectFormat — webp + avif", () => {
  it("recognizes a real WebP buffer", async () => {
    const buf = await webpEncode(solidImageData(8, 8, 255, 0, 0));
    expect(detectFormat(new Uint8Array(buf))).toBe("webp");
  });

  it("recognizes a real AVIF buffer", async () => {
    const buf = await avifEncode(solidImageData(8, 8, 0, 255, 0));
    expect(detectFormat(new Uint8Array(buf))).toBe("avif");
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

// ── WebP end-to-end ────────────────────────────────────────────────────────

describe("generateThumbnail — WebP", () => {
  it("decodes a 200x200 source, resizes to ~50x50, emits valid WebP", async () => {
    const src = new Uint8Array(await webpEncode(solidImageData(200, 200, 220, 30, 30)));
    expect(detectFormat(src)).toBe("webp");

    const thumb = await generateThumbnail(src, { width: 50, height: 50, fit: "contain" }, "webp");
    expect(thumb.byteLength).toBeGreaterThan(0);
    expect(detectFormat(thumb)).toBe("webp");

    const decoded = await webpDecode(thumb.buffer.slice(thumb.byteOffset, thumb.byteOffset + thumb.byteLength) as ArrayBuffer);
    expect(decoded.width).toBe(50);
    expect(decoded.height).toBe(50);
  });

  it("cover fit produces exact target dims for non-square source", async () => {
    const src = new Uint8Array(await webpEncode(solidImageData(120, 60, 30, 60, 220)));
    const thumb = await generateThumbnail(src, { width: 40, height: 40, fit: "cover" }, "webp");
    const decoded = await webpDecode(thumb.buffer.slice(thumb.byteOffset, thumb.byteOffset + thumb.byteLength) as ArrayBuffer);
    expect(decoded.width).toBe(40);
    expect(decoded.height).toBe(40);
  });
});

// ── AVIF end-to-end ───────────────────────────────────────────────────────

describe("generateThumbnail — AVIF", () => {
  it("decodes a 32x32 source, resizes to 16x16, emits valid AVIF", async () => {
    // Keep the encode small — AVIF encoding is the slow leg of these tests.
    const src = new Uint8Array(await avifEncode(solidImageData(32, 32, 30, 200, 30)));
    expect(detectFormat(src)).toBe("avif");

    const thumb = await generateThumbnail(src, { width: 16, height: 16, fit: "contain" }, "avif");
    expect(thumb.byteLength).toBeGreaterThan(0);
    expect(detectFormat(thumb)).toBe("avif");

    const decoded = await avifDecode(thumb.buffer.slice(thumb.byteOffset, thumb.byteOffset + thumb.byteLength) as ArrayBuffer);
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(16);
  }, 30_000); // AVIF encode is slow; give the test ample headroom.
});

// ── Animated GIF ──────────────────────────────────────────────────────────

async function makeAnimatedGif(): Promise<Uint8Array> {
  // Two 60x60 frames: solid red, then solid green; 100ms each.
  const f1 = new Image(60, 60);
  f1.fill(Image.rgbaToColor(255, 0, 0, 255));
  const f2 = new Image(60, 60);
  f2.fill(Image.rgbaToColor(0, 255, 0, 255));
  const gif = new GIF([Frame.from(f1, 100), Frame.from(f2, 100)]);
  return await gif.encode(95);
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
    const f1 = new Image(80, 40);
    f1.fill(Image.rgbaToColor(50, 50, 200, 255));
    const oneFrame = new GIF([Frame.from(f1, 100)]);
    const src = await oneFrame.encode(95);
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
