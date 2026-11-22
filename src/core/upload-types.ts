/**
 * The file types an upload may have: a catalogue an admin picks from
 * (Settings → File storage → Allowed file types, setting
 * `files.allowed_types`), and the default when nothing is picked.
 *
 * Only types in the catalogue can be allowed. Types that run as code in a
 * browser (HTML, XHTML, JavaScript) are not in it, so no setting can let
 * them in. Whatever is allowed, only raster images are ever served inline;
 * every other file is sent as a download (api/files.ts).
 *
 * No imports: the admin bundle includes this file for its checkboxes.
 */

export interface UploadType {
  /** A MIME type, or `image/*` for every image type. */
  mime: string;
  label: string;
  group: "Images" | "Documents" | "Data" | "Archives" | "Audio" | "Video" | "Other";
  /** Extension the stored file gets. */
  ext: string;
}

export const UPLOAD_TYPES: readonly UploadType[] = [
  { mime: "image/*", label: "All images (PNG, JPEG, GIF, WebP, AVIF, SVG, …)", group: "Images", ext: "bin" },
  { mime: "application/pdf", label: "PDF", group: "Documents", ext: "pdf" },
  { mime: "text/plain", label: "Plain text", group: "Documents", ext: "txt" },
  { mime: "text/markdown", label: "Markdown", group: "Documents", ext: "md" },
  { mime: "application/rtf", label: "Rich text (RTF)", group: "Documents", ext: "rtf" },
  { mime: "application/msword", label: "Word (.doc)", group: "Documents", ext: "doc" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word (.docx)", group: "Documents", ext: "docx" },
  { mime: "application/vnd.ms-excel", label: "Excel (.xls)", group: "Documents", ext: "xls" },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel (.xlsx)", group: "Documents", ext: "xlsx" },
  { mime: "application/vnd.ms-powerpoint", label: "PowerPoint (.ppt)", group: "Documents", ext: "ppt" },
  { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint (.pptx)", group: "Documents", ext: "pptx" },
  { mime: "application/vnd.oasis.opendocument.text", label: "OpenDocument text (.odt)", group: "Documents", ext: "odt" },
  { mime: "application/vnd.oasis.opendocument.spreadsheet", label: "OpenDocument spreadsheet (.ods)", group: "Documents", ext: "ods" },
  { mime: "application/json", label: "JSON", group: "Data", ext: "json" },
  { mime: "text/csv", label: "CSV", group: "Data", ext: "csv" },
  { mime: "application/xml", label: "XML", group: "Data", ext: "xml" },
  { mime: "application/zip", label: "Zip", group: "Archives", ext: "zip" },
  { mime: "application/x-zip-compressed", label: "Zip (as Windows browsers send it)", group: "Archives", ext: "zip" },
  { mime: "application/gzip", label: "Gzip", group: "Archives", ext: "gz" },
  { mime: "application/x-tar", label: "Tar", group: "Archives", ext: "tar" },
  { mime: "application/x-7z-compressed", label: "7-Zip", group: "Archives", ext: "7z" },
  { mime: "audio/mpeg", label: "MP3", group: "Audio", ext: "mp3" },
  { mime: "audio/wav", label: "WAV", group: "Audio", ext: "wav" },
  { mime: "audio/ogg", label: "Ogg audio", group: "Audio", ext: "ogg" },
  { mime: "audio/mp4", label: "M4A / AAC", group: "Audio", ext: "m4a" },
  { mime: "video/mp4", label: "MP4 video", group: "Video", ext: "mp4" },
  { mime: "video/webm", label: "WebM video", group: "Video", ext: "webm" },
  { mime: "video/quicktime", label: "QuickTime (.mov)", group: "Video", ext: "mov" },
  { mime: "application/octet-stream", label: "Unknown binary (application/octet-stream)", group: "Other", ext: "bin" },
];

/** What's allowed when `files.allowed_types` is unset or empty: the list before the setting existed. */
export const DEFAULT_UPLOAD_TYPES: readonly string[] = [
  "image/*", "application/pdf", "text/plain", "application/json", "application/octet-stream",
  "text/markdown", "text/csv", "application/zip", "application/x-zip-compressed",
];

const CATALOGUE = new Map(UPLOAD_TYPES.map((t) => [t.mime, t]));

/**
 * The allowed types from a stored setting value: a JSON array of catalogue
 * MIME types. Unset, empty or unreadable means the defaults; unknown
 * entries are dropped.
 */
export function parseAllowedTypes(raw: string | null | undefined): string[] {
  if (!raw || raw.trim() === "") return [...DEFAULT_UPLOAD_TYPES];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return [...DEFAULT_UPLOAD_TYPES]; }
  if (!Array.isArray(list)) return [...DEFAULT_UPLOAD_TYPES];
  return [...new Set(list.filter((m): m is string => typeof m === "string" && CATALOGUE.has(m)))];
}

/** Why a value can't be stored as `files.allowed_types`, or null. */
export function validateAllowedTypes(raw: unknown): string | null {
  if (raw === "" || raw === null || raw === undefined) return null;
  let list: unknown;
  try { list = JSON.parse(String(raw)); } catch { return "must be a JSON array of MIME types"; }
  if (!Array.isArray(list)) return "must be a JSON array of MIME types";
  const unknown = list.filter((m) => typeof m !== "string" || !CATALOGUE.has(m));
  if (unknown.length) return `can't allow ${unknown.map((m) => JSON.stringify(m)).join(", ")}: only the types listed in Settings → File storage can be allowed`;
  return null;
}

/** An upload of type `mime` (no parameters, lower case) is allowed by `allowed`. */
export function mimeInAllowed(mime: string, allowed: readonly string[]): boolean {
  const m = mime.toLowerCase();
  if (allowed.includes(m)) return true;
  return m.startsWith("image/") && allowed.includes("image/*");
}

/** The stored extension for an allowed type ("bin" when unknown). */
export function extForMime(mime: string): string | null {
  const t = CATALOGUE.get(mime.toLowerCase());
  return t && t.mime !== "image/*" ? t.ext : null;
}
