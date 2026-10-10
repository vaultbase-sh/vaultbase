import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { Image, GIF } from "imagescript";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import "./codecs";

/**
 * Lightweight thumbnail generator.
 *
 * Engine matrix:
 *   - JPEG / PNG / WebP / static GIF: `Bun.Image` (native decode, resize, encode)
 *   - Crop for `cover` fit: `imagescript`, on the already-shrunk image only
 *     (Bun.Image has no crop)
 *   - Animated GIF: `imagescript` decode + resize, `gifenc` encode
 *   - AVIF: not thumbnailed — served as the original. Bun.Image can't read AVIF
 *     on Linux without an OS codec, and bundling one costs ~4.5 MB.
 *
 * imagescript's own JPEG / GIF encoders are native addons that cannot ship in
 * a single binary (see scripts/patch-imagescript.ts), so they are never called;
 * its PNG / GIF WASM is embedded via ./codecs.
 *
 * On-disk cache lives at `<uploadDir>/.thumbs/<filename>__<W>x<H>[_<fit>][.<fmt>][_q<N>]`
 * so repeat fetches read straight from disk without re-encoding. Fit, output
 * format and quality are part of the cache key so variants don't collide.
 * Without `format` the output is in the *source* format — webp in, webp out.
 *
 * Output formats are jpeg / png / webp only: Bun.Image encodes AVIF through
 * an OS encoder that Linux servers don't have.
 */

export type ThumbFormat = "jpeg" | "png" | "gif" | "webp" | "avif";

/** How the source is fitted into the requested W×H. `crop` is an alias of `cover`. */
export type ThumbFit = "contain" | "cover" | "crop";

const MIN_DIM = 1;
/** zlib level for PNG thumbs. 0 is stored-only (bigger than most originals, and imagescript can't read it back). */
const PNG_LEVEL = 3;
const MAX_DIM = 4096;

/** Formats a thumbnail can be re-encoded to. */
export type OutputFormat = "jpeg" | "png" | "webp";

export interface ThumbSpec {
  /** 0 = derive from the other side's aspect ratio. Both 0 = source size. */
  width: number;
  height: number;
  /** Defaults to "contain" (preserves prior behavior when fit is omitted). */
  fit: ThumbFit;
  /** Re-encode to this format; source format when unset. */
  format?: OutputFormat;
  /** 1-100, jpeg / webp only. Encoder default when unset. */
  quality?: number;
}

/**
 * Parse `?thumb=` value. Returns null if malformed or out of range.
 *
 * Accepted forms:
 *   - `WxH`              → contain (legacy)
 *   - `WxH&fit=MODE`     → fit explicit (mode in {contain, cover, crop})
 *   - `WxH_MODE`         → fit suffix shorthand (e.g. `200x200_cover`)
 *
 * One side may be 0 (`400x0`, `0x300`) to keep the aspect ratio; that is
 * always a contain fit.
 */
export function parseThumbSpec(raw: string | null | undefined): ThumbSpec | null {
  if (!raw) return null;

  // Pull off an optional `&fit=mode` suffix first.
  let fit: ThumbFit = "contain";
  let body = raw;
  const fitMatch = body.match(/^(.*)&fit=(contain|cover|crop)$/);
  if (fitMatch) {
    body = fitMatch[1]!;
    fit = fitMatch[2] as ThumbFit;
  }

  // Then accept `WxH` or `WxH_mode` shorthand.
  const m = body.match(/^(\d+)x(\d+)(?:_(contain|cover|crop))?$/);
  if (!m) return null;
  const width = parseInt(m[1]!, 10);
  const height = parseInt(m[2]!, 10);
  if (m[3] && fitMatch) return null; // can't mix `_mode` and `&fit=`
  if (m[3]) fit = m[3] as ThumbFit;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const okDim = (n: number) => n === 0 || (n >= MIN_DIM && n <= MAX_DIM);
  if (!okDim(width) || !okDim(height) || (width === 0 && height === 0)) return null;
  // With one side derived there is nothing to crop.
  if (width === 0 || height === 0) fit = "contain";
  return { width, height, fit };
}

/** Canonical `WxH[_fit]` form of a spec's size, used for allow-lists. */
export function thumbSizeKey(spec: Pick<ThumbSpec, "width" | "height" | "fit">): string {
  const fit = spec.fit === "crop" ? "cover" : spec.fit;
  return `${spec.width}x${spec.height}${fit === "contain" ? "" : `_${fit}`}`;
}

/**
 * Parse `?format=` / `?quality=`. `auto` picks webp when the client's
 * Accept header allows it and keeps the source format otherwise. Returns a
 * string error for invalid input.
 */
export function parseOutputOptions(
  format: string | undefined,
  quality: string | undefined,
  accept: string | null,
): { format?: OutputFormat; quality?: number; auto: boolean } | string {
  const out: { format?: OutputFormat; quality?: number; auto: boolean } = { auto: false };
  if (format !== undefined && format !== "") {
    const f = format.toLowerCase();
    if (f === "auto") {
      out.auto = true;
      if (accept && /image\/webp/i.test(accept)) out.format = "webp";
    } else if (f === "jpeg" || f === "jpg") out.format = "jpeg";
    else if (f === "png" || f === "webp") out.format = f;
    else return "format must be one of webp, jpeg, png, auto";
  }
  if (quality !== undefined && quality !== "") {
    const q = Number(quality);
    if (!Number.isInteger(q) || q < 1 || q > 100) return "quality must be a whole number from 1 to 100";
    out.quality = q;
  }
  return out;
}

/** Detect format from the first few bytes of the file. */
export function detectFormat(bytes: Uint8Array): ThumbFormat | null {
  if (bytes.length < 8) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return "gif";
  // WebP and AVIF need 12 bytes for their fourcc/major brand check.
  if (bytes.length < 12) return null;
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  // AVIF: ISO BMFF — bytes 4..7 = "ftyp", bytes 8..11 = "avif" major brand.
  if (
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
    bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66
  ) return "avif";
  return null;
}

/** Map a ThumbFormat to its canonical Content-Type / mime string. */
export function thumbMime(format: ThumbFormat): string {
  switch (format) {
    case "jpeg": return "image/jpeg";
    case "png":  return "image/png";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "avif": return "image/avif";
  }
}

function thumbCacheDir(uploadDir: string): string {
  const dir = join(uploadDir, ".thumbs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function thumbCachePath(uploadDir: string, filename: string, spec: ThumbSpec): string {
  // Keep the legacy `<filename>__WxH` shape for the default contain mode so
  // existing on-disk caches stay valid; only append the fit suffix for non-default
  // modes. `crop` and `cover` produce identical bytes so they share a cache entry.
  const fitTag = spec.fit === "contain" ? "" : `_${spec.fit === "crop" ? "cover" : spec.fit}`;
  const fmtTag = spec.format ? `.${spec.format}` : "";
  const qTag = spec.quality !== undefined && spec.format !== "png" ? `_q${spec.quality}` : "";
  return join(thumbCacheDir(uploadDir), `${filename}__${spec.width}x${spec.height}${fitTag}${fmtTag}${qTag}`);
}

/** Compute the (width, height) of a single resized frame for the given fit mode. */
function fitDimensions(srcW: number, srcH: number, spec: ThumbSpec): {
  newW: number;
  newH: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
} {
  if (spec.fit === "cover" || spec.fit === "crop") {
    // Center-crop the source to the target aspect ratio first, then scale.
    const srcAspect = srcW / srcH;
    const tgtAspect = spec.width / spec.height;
    let cropW = srcW;
    let cropH = srcH;
    if (srcAspect > tgtAspect) {
      // source is wider than target → crop horizontally
      cropW = Math.max(1, Math.round(srcH * tgtAspect));
    } else if (srcAspect < tgtAspect) {
      // source is taller → crop vertically
      cropH = Math.max(1, Math.round(srcW / tgtAspect));
    }
    const cropX = Math.floor((srcW - cropW) / 2);
    const cropY = Math.floor((srcH - cropH) / 2);
    return { newW: spec.width, newH: spec.height, cropX, cropY, cropW, cropH };
  }
  // contain: fit-within preserving aspect ratio (legacy behavior). A 0 side
  // follows the other side's scale; both 0 keeps the source size.
  if (spec.width === 0 && spec.height === 0) {
    return { newW: srcW, newH: srcH, cropX: 0, cropY: 0, cropW: srcW, cropH: srcH };
  }
  const aspect = srcW / srcH;
  if (spec.height === 0) {
    return { newW: spec.width, newH: Math.max(1, Math.round(spec.width / aspect)), cropX: 0, cropY: 0, cropW: srcW, cropH: srcH };
  }
  if (spec.width === 0) {
    return { newW: Math.max(1, Math.round(spec.height * aspect)), newH: spec.height, cropX: 0, cropY: 0, cropW: srcW, cropH: srcH };
  }
  const targetAspect = spec.width / spec.height;
  let newW: number, newH: number;
  if (aspect > targetAspect) {
    newW = spec.width;
    newH = Math.max(1, Math.round(spec.width / aspect));
  } else {
    newH = spec.height;
    newW = Math.max(1, Math.round(spec.height * aspect));
  }
  return { newW, newH, cropX: 0, cropY: 0, cropW: srcW, cropH: srcH };
}

/** Resize an imagescript Image per a fit spec. Mutates and returns the same instance. */
function fitImage(img: Image, spec: ThumbSpec): Image {
  const dims = fitDimensions(img.width, img.height, spec);
  if (spec.fit === "cover" || spec.fit === "crop") {
    const cropped = img.crop(dims.cropX, dims.cropY, dims.cropW, dims.cropH);
    return cropped.resize(dims.newW, dims.newH) as Image;
  }
  return img.resize(dims.newW, dims.newH) as Image;
}

/** Whether `generateThumbnail` handles this format; others are served as the original. */
export function canThumbnail(format: ThumbFormat): boolean {
  return format !== "avif";
}

/**
 * Decode → resize → encode.
 *
 * - `contain` (default): scale-to-fit preserving aspect ratio. Output may be
 *   smaller than W×H on one axis — same as the original behavior.
 * - `cover`:  scale-and-crop so output exactly matches W×H. The source is
 *   center-cropped to the target aspect ratio first.
 * - `crop`:   alias of `cover`.
 *
 * Without `spec.format` the output is in the source `format` — webp in, webp
 * out, etc. A static GIF comes out as PNG; an animated GIF stays an animated
 * GIF unless a format is requested, which renders its first frame. Throws
 * for formats `canThumbnail` rejects.
 */
export async function generateThumbnail(
  bytes: Uint8Array,
  spec: ThumbSpec,
  format: ThumbFormat
): Promise<Uint8Array> {
  if (format === "avif") throw new Error("thumbnails are not supported for avif");
  if (spec.format) return await thumbnailStill(bytes, spec, spec.format);
  if (format === "gif") return await thumbnailGif(bytes, spec);
  return await thumbnailStill(bytes, spec, format);
}

type StillFormat = OutputFormat;

function encodeAs(img: Bun.Image, format: StillFormat, quality?: number): Promise<Uint8Array> {
  if (format === "jpeg") return img.jpeg({ quality: quality ?? 85 }).bytes();
  if (format === "webp") return img.webp({ quality: quality ?? 80 }).bytes();
  return img.png().bytes();
}

async function thumbnailStill(bytes: Uint8Array, spec: ThumbSpec, format: StillFormat): Promise<Uint8Array> {
  const { width, height } = await new Bun.Image(bytes).metadata();
  const dims = fitDimensions(width, height, spec);

  if (spec.fit === "contain") {
    const img = new Bun.Image(bytes);
    if (dims.newW !== width || dims.newH !== height) img.resize(dims.newW, dims.newH, { fit: "fill" });
    return encodeAs(img, format, spec.quality);
  }

  // cover: scale so the crop box lands exactly on W×H, then crop that small
  // image. Bun.Image can't crop, so the crop runs in imagescript — on a
  // thumbnail-sized bitmap, never the full-size source.
  const scale = spec.width / dims.cropW;
  const scaledW = Math.max(spec.width, Math.round(width * scale));
  const scaledH = Math.max(spec.height, Math.round(height * scale));
  const scaled = await Image.decode(
    await new Bun.Image(bytes).resize(scaledW, scaledH, { fit: "fill" }).png().bytes(),
  );
  const cropped = scaled.crop(
    Math.floor((scaledW - spec.width) / 2),
    Math.floor((scaledH - spec.height) / 2),
    spec.width,
    spec.height,
  );
  const png = await cropped.encode(PNG_LEVEL);
  return format === "png" ? png : encodeAs(new Bun.Image(png), format, spec.quality);
}

/**
 * GIF thumbnailing.
 *
 * Animated source → animated thumb: decode all frames via `GIF.decode` (they
 * come back as full, already-composited canvases), resize each via the same
 * fit math, and re-encode with `gifenc`, keeping per-frame delays and the
 * loop count.
 *
 * Static source (1 frame) → emit a PNG (matches the prior behavior; saves the
 * GIF encoder hit when there's only one frame anyway).
 *
 * Fallback: any decoder/encoder error in the animated path drops back to the
 * legacy "first frame as PNG" emission so a malformed GIF can't 500 the route.
 */
async function thumbnailGif(bytes: Uint8Array, spec: ThumbSpec): Promise<Uint8Array> {
  try {
    const gif = await GIF.decode(bytes);
    if (gif.length <= 1) {
      // Single-frame GIF: cheaper to ship as PNG, same as the old code path.
      return await thumbnailStill(bytes, spec, "png");
    }

    // imagescript: -1 = loop forever. gifenc: 0 = forever, n = n repeats.
    const loopCount = (gif as unknown as { loopCount?: number }).loopCount ?? -1;
    const repeat = loopCount <= 0 ? 0 : loopCount;
    const enc = GIFEncoder();
    for (const frame of gif) {
      // Frame extends Image but the typings expose an incompatible private
      // `toString` — go through `unknown` to keep the runtime polymorphism.
      const resized = fitImage((frame as unknown as Image).clone() as Image, spec);
      const rgba = resized.bitmap;
      const palette = quantize(rgba, 256, { format: "rgba4444", oneBitAlpha: true });
      const transparentIndex = palette.findIndex((c) => c[3] === 0);
      enc.writeFrame(applyPalette(rgba, palette, "rgba4444"), resized.width, resized.height, {
        palette,
        delay: frame.duration,
        repeat,
        ...(transparentIndex >= 0 ? { transparent: true, transparentIndex } : {}),
      });
    }
    enc.finish();
    return enc.bytes();
  } catch {
    // Animated decode/encode pipeline failed (imagescript's GIF support has been
    // historically finicky on certain inputs). Fall back to "first frame as PNG"
    // — same as the old behavior.
    return await thumbnailStill(bytes, spec, "png");
  }
}

// ── Variant cap ─────────────────────────────────────────────────────────────

/**
 * Most distinct cached variants (size × fit × format × quality) one file may
 * accumulate from non-admin requests. Bounds the CPU and disk an anonymous
 * caller can burn by asking for ever-new sizes; past it, the original is
 * served instead.
 */
export const MAX_THUMB_VARIANTS = 32;

/** filename → cached variant count; built lazily from `.thumbs` on first use. */
let variantCounts: Map<string, number> | null = null;

export function thumbVariantCount(uploadDir: string, filename: string): number {
  if (!variantCounts) {
    variantCounts = new Map();
    const dir = join(uploadDir, ".thumbs");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".tmp")) continue;
        const i = name.lastIndexOf("__");
        if (i <= 0) continue;
        const f = name.slice(0, i);
        variantCounts.set(f, (variantCounts.get(f) ?? 0) + 1);
      }
    }
  }
  return variantCounts.get(filename) ?? 0;
}

export function noteThumbVariant(filename: string): void {
  if (variantCounts) variantCounts.set(filename, (variantCounts.get(filename) ?? 0) + 1);
}

/** Forget counts after thumbs are deleted: one file, or all when omitted. */
export function forgetThumbVariants(filename?: string): void {
  if (filename === undefined) variantCounts = null;
  else variantCounts?.delete(filename);
}
