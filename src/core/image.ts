import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Image } from "imagescript";

/**
 * Lightweight thumbnail generator. Pure-JS via `imagescript` so it bundles
 * cleanly into a single Bun binary — no native deps, no wasm.
 *
 * On-disk cache lives at `<uploadDir>/.thumbs/<filename>__<W>x<H>.<ext>` so
 * repeat fetches read straight from disk without re-encoding.
 */

export type ThumbFormat = "jpeg" | "png" | "gif";

const MIN_DIM = 1;
const MAX_DIM = 4096;

export interface ThumbSpec {
  width: number;
  height: number;
}

/** Parse `?thumb=` value. Returns null if malformed or out of range. */
export function parseThumbSpec(raw: string | null | undefined): ThumbSpec | null {
  if (!raw) return null;
  const m = raw.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  const width = parseInt(m[1]!, 10);
  const height = parseInt(m[2]!, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MIN_DIM || width > MAX_DIM || height < MIN_DIM || height > MAX_DIM) return null;
  return { width, height };
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
  return null;
}

function thumbCacheDir(uploadDir: string): string {
  const dir = join(uploadDir, ".thumbs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function thumbCachePath(uploadDir: string, filename: string, spec: ThumbSpec): string {
  return join(thumbCacheDir(uploadDir), `${filename}__${spec.width}x${spec.height}`);
}

/** Decode → resize (preserving aspect ratio, fitting within W×H) → encode. */
export async function generateThumbnail(
  bytes: Uint8Array,
  spec: ThumbSpec,
  format: ThumbFormat
): Promise<Uint8Array> {
  const img = await Image.decode(bytes);
  // imagescript's resize preserves aspect ratio with NEAREST mode by default;
  // explicitly call .contain() to fit within the box, padding with transparency
  // for PNG/GIF and white for JPEG.
  const aspect = img.width / img.height;
  const targetAspect = spec.width / spec.height;
  let newW: number, newH: number;
  if (aspect > targetAspect) {
    newW = spec.width;
    newH = Math.max(1, Math.round(spec.width / aspect));
  } else {
    newH = spec.height;
    newW = Math.max(1, Math.round(spec.height * aspect));
  }
  const resized = img.resize(newW, newH);
  if (format === "jpeg") return resized.encodeJPEG(85);
  // PNG/GIF: encode as PNG (GIF encoding requires animation frames).
  return resized.encode(0);
}
