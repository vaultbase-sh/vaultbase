import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Image, GIF, Frame } from "imagescript";

/**
 * Lightweight thumbnail generator.
 *
 * Engine matrix:
 *   - PNG / JPEG / GIF (static + animated): `imagescript` (pure JS)
 *   - WebP / AVIF: `@jsquash/webp` and `@jsquash/avif` (zero-dep WASM)
 *
 * On-disk cache lives at `<uploadDir>/.thumbs/<filename>__<W>x<H>[_<fit>].<ext>`
 * so repeat fetches read straight from disk without re-encoding. The fit mode
 * is part of the cache key so contain/cover variants don't collide. The cached
 * file is the encoded bytes in the *source* format — webp in, webp out.
 */

export type ThumbFormat = "jpeg" | "png" | "gif" | "webp" | "avif";

/** How the source is fitted into the requested W×H. `crop` is an alias of `cover`. */
export type ThumbFit = "contain" | "cover" | "crop";

const MIN_DIM = 1;
const MAX_DIM = 4096;

export interface ThumbSpec {
  width: number;
  height: number;
  /** Defaults to "contain" (preserves prior behavior when fit is omitted). */
  fit: ThumbFit;
}

/**
 * Parse `?thumb=` value. Returns null if malformed or out of range.
 *
 * Accepted forms:
 *   - `WxH`              → contain (legacy)
 *   - `WxH&fit=MODE`     → fit explicit (mode in {contain, cover, crop})
 *   - `WxH_MODE`         → fit suffix shorthand (e.g. `200x200_cover`)
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
  if (width < MIN_DIM || width > MAX_DIM || height < MIN_DIM || height > MAX_DIM) return null;
  return { width, height, fit };
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
  return join(thumbCacheDir(uploadDir), `${filename}__${spec.width}x${spec.height}${fitTag}`);
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
  // contain: fit-within preserving aspect ratio (legacy behavior).
  const aspect = srcW / srcH;
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

/** Build an imagescript Image from a decoded ImageData. */
function imageFromImageData(id: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): Image {
  const out = new Image(id.width, id.height);
  // imagescript's Image.bitmap is a Uint8ClampedArray of RGBA in row-major order —
  // the same layout as web ImageData, so a straight set() is correct.
  out.bitmap.set(id.data as Uint8ClampedArray);
  return out;
}

/**
 * The shape `@jsquash/*` encoders consume — a structural subset of the DOM
 * ImageData. We avoid pulling in the DOM lib by defining it locally.
 */
interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace?: "srgb" | "display-p3";
}

/** Convert an imagescript Image back into a plain ImageData-shaped object. */
function imageDataFromImage(img: Image): ImageDataLike {
  // Construct an ImageData-shaped literal — the @jsquash encoders only read
  // .data/.width/.height and tolerate the colorSpace field.
  return {
    data: new Uint8ClampedArray(img.bitmap.buffer, img.bitmap.byteOffset, img.bitmap.byteLength),
    width: img.width,
    height: img.height,
    colorSpace: "srgb",
  };
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
 * The output bytes are always in `format` — webp in, webp out, etc.
 */
export async function generateThumbnail(
  bytes: Uint8Array,
  spec: ThumbSpec,
  format: ThumbFormat
): Promise<Uint8Array> {
  if (format === "webp") return await thumbnailWebp(bytes, spec);
  if (format === "avif") return await thumbnailAvif(bytes, spec);
  if (format === "gif")  return await thumbnailGif(bytes, spec);

  // PNG / JPEG path — vanilla imagescript.
  const img = await Image.decode(bytes);
  const resized = fitImage(img, spec);
  if (format === "jpeg") return resized.encodeJPEG(85);
  return resized.encode(0);
}

async function thumbnailWebp(bytes: Uint8Array, spec: ThumbSpec): Promise<Uint8Array> {
  const { decode, encode } = await import("@jsquash/webp");
  // @jsquash takes ArrayBuffer; build a tight one in case `bytes` is a slice.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const decoded = await decode(ab);
  const img = imageFromImageData(decoded);
  const resized = fitImage(img, spec);
  const out = await encode(imageDataFromImage(resized));
  return new Uint8Array(out);
}

async function thumbnailAvif(bytes: Uint8Array, spec: ThumbSpec): Promise<Uint8Array> {
  const { decode, encode } = await import("@jsquash/avif");
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const decoded = await decode(ab);
  const img = imageFromImageData(decoded);
  const resized = fitImage(img, spec);
  const out = await encode(imageDataFromImage(resized));
  return new Uint8Array(out);
}

/**
 * GIF thumbnailing.
 *
 * Animated source → animated thumb: decode all frames via `GIF.decode`, resize
 * each via the same fit math, preserve per-frame `duration` + `disposalMode`
 * + the GIF's `loopCount`, re-encode via `GIF.encode`.
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
      const single = gif[0] ?? (await Image.decode(bytes));
      const resized = fitImage(single as Image, spec);
      return resized.encode(0);
    }

    // Multi-frame: resize every frame, keep its duration + disposal flag.
    const newFrames: Frame[] = [];
    for (const frame of gif) {
      const dims = fitDimensions(frame.width, frame.height, spec);
      // Frame extends Image but the typings expose an incompatible private
      // `toString` — go through `unknown` to keep the runtime polymorphism.
      let working: Image = frame as unknown as Image;
      if (spec.fit === "cover" || spec.fit === "crop") {
        working = (working.clone() as Image).crop(dims.cropX, dims.cropY, dims.cropW, dims.cropH) as Image;
      }
      const resized = (working.clone() as Image).resize(dims.newW, dims.newH) as Image;
      // `Frame.from` clones the bitmap and copies metadata.
      newFrames.push(Frame.from(resized, frame.duration, 0, 0, frame.disposalMode));
    }
    // Loop count: imagescript exposes it on the GIF instance via `loopCount` in
    // some builds; if missing default to -1 (infinite) to match standard GIF.
    const loopCount = (gif as unknown as { loopCount?: number }).loopCount ?? -1;
    const outGif = new GIF(newFrames, loopCount);
    return await outGif.encode(95);
  } catch {
    // Animated decode/encode pipeline failed (imagescript's GIF support has been
    // historically finicky on certain inputs). Fall back to "first frame as PNG"
    // — same as the old behavior, never throws further.
    const img = await Image.decode(bytes);
    const resized = fitImage(img, spec);
    return resized.encode(0);
  }
}
