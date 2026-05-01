/**
 * Minimal HTML sanitizer for the `editor` field type.
 *
 * Defense-in-depth against the Quill XSS class (CVE-2025-15056 / GHSA-v3m3-f69x-jf25),
 * where malicious payload survives Quill's HTML export. We strip any markup
 * that can execute script, embed remote resources, or steal context — applied
 * server-side on every editor-field write.
 *
 * No external dependency: a single tokenizer pass over the input. The
 * allow-list is intentionally narrow (the same tags Quill emits in normal
 * use). Anything outside the allow-list is dropped (the contained text is
 * preserved). Inline event handlers, javascript:/data: URLs, and dangerous
 * URL schemes on `href`/`src`/`xlink:href` are stripped.
 */

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  // Block
  "p", "div", "blockquote", "pre", "hr", "br",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  // Inline
  "span", "strong", "b", "em", "i", "u", "s", "strike", "code", "sub", "sup",
  "a", "img",
  // Tables (Quill table module emits these)
  "table", "thead", "tbody", "tr", "th", "td",
]);

const ALLOWED_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["a",   new Set(["href", "title", "rel", "target"])],
  ["img", new Set(["src", "alt", "title", "width", "height"])],
  ["span",new Set(["class"])],
  ["p",   new Set(["class"])],
  ["pre", new Set(["class"])],
  ["code",new Set(["class"])],
  ["ol",  new Set(["start"])],
  ["li",  new Set(["class"])],
  ["table", new Set(["class"])],
  ["th",  new Set(["colspan", "rowspan"])],
  ["td",  new Set(["colspan", "rowspan"])],
]);

const URL_ATTRS: ReadonlySet<string> = new Set(["href", "src", "xlink:href"]);

/**
 * Deny-list of URL schemes for href/src. We default-allow because a relative
 * URL like `images/x.png` has no scheme and is the common case. Anything
 * matching this regex is rejected.
 */
const DENIED_SCHEMES = /^\s*(?:javascript|vbscript|file)\s*:/i;
/** `data:` URLs are denied unless they're an image MIME (`data:image/...`). */
const DENIED_DATA_SCHEME = /^\s*data\s*:/i;
const ALLOWED_DATA_IMAGE = /^\s*data:image\/(?:png|jpeg|jpg|gif|webp|avif);/i;

/**
 * Returns a sanitized HTML string. The shape is preserved as much as possible
 * — disallowed tags are unwrapped (their text content kept), disallowed
 * attributes are removed.
 */
export function sanitizeHtml(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";

  let out = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    const c = input[i];

    if (c === "<") {
      // Comments and CDATA — strip entirely.
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i + 4);
        if (end < 0) break;
        i = end + 3;
        continue;
      }
      if (input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf("]]>", i + 9);
        if (end < 0) break;
        i = end + 3;
        continue;
      }
      // Doctype / XML / processing instruction — strip.
      if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
        const end = input.indexOf(">", i + 2);
        if (end < 0) break;
        i = end + 1;
        continue;
      }

      // Find the end of the tag.
      const tagEnd = findTagEnd(input, i + 1);
      if (tagEnd < 0) {
        // Stray `<` — escape it as text.
        out += "&lt;";
        i += 1;
        continue;
      }
      const raw = input.slice(i + 1, tagEnd);
      const isClose = raw.startsWith("/");
      const inner = isClose ? raw.slice(1) : raw;
      const m = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
      if (!m) {
        out += "&lt;";
        i += 1;
        continue;
      }
      const tagName = (m[1] ?? "").toLowerCase();
      i = tagEnd + 1;

      if (!ALLOWED_TAGS.has(tagName)) {
        // Drop the tag, keep the text content. Block-level dangerous tags
        // (script/style/iframe/etc.) get their content stripped too.
        if (
          tagName === "script" ||
          tagName === "style" ||
          tagName === "iframe" ||
          tagName === "object" ||
          tagName === "embed" ||
          tagName === "svg" ||
          tagName === "math" ||
          tagName === "form" ||
          tagName === "frameset" ||
          tagName === "frame"
        ) {
          // Skip until matching close tag (or end of input).
          if (!isClose) {
            const closeIdx = findCloseTag(input, i, tagName);
            i = closeIdx < 0 ? len : closeIdx;
          }
        }
        continue;
      }

      if (isClose) {
        out += `</${tagName}>`;
        continue;
      }

      // Self-closing detection.
      const isSelfClosing = inner.endsWith("/");
      const attrsRaw = inner.slice((m[1] ?? "").length, isSelfClosing ? -1 : undefined).trim();
      const attrs = parseAttrs(attrsRaw);
      const allowedAttrs = ALLOWED_ATTRS.get(tagName) ?? new Set<string>();
      let attrStr = "";
      for (const [name, value] of attrs) {
        const lower = name.toLowerCase();
        // Strip every `on*` event handler regardless of tag.
        if (lower.startsWith("on")) continue;
        if (lower === "style") continue; // CSS expressions / url() exfil
        if (!allowedAttrs.has(lower)) continue;
        let v = value;
        if (URL_ATTRS.has(lower)) {
          // Browsers strip TAB / LF / CR from URL schemes before parsing
          // (see WHATWG URL §basic-url-parse), so `java&#9;script:` resolves
          // to `javascript:` at render time. Replicate that quirk here so
          // the scheme check sees what the browser will see.
          const normalized = stripUrlControlChars(v.trim());
          if (DENIED_SCHEMES.test(normalized)) continue;
          if (DENIED_DATA_SCHEME.test(normalized) && !ALLOWED_DATA_IMAGE.test(normalized)) continue;
        }
        attrStr += ` ${lower}="${escapeAttr(v)}"`;
      }
      // For <a target=…> ensure noopener noreferrer to prevent reverse tab-nabbing.
      if (tagName === "a") {
        const hasTarget = /\btarget=/i.test(attrStr);
        if (hasTarget && !/\brel=/i.test(attrStr)) {
          attrStr += ` rel="noopener noreferrer"`;
        }
      }
      out += `<${tagName}${attrStr}${isSelfClosing ? " />" : ">"}`;
      continue;
    }

    // Text node — collect until next `<`.
    const next = input.indexOf("<", i);
    const chunk = next < 0 ? input.slice(i) : input.slice(i, next);
    out += chunk;
    i = next < 0 ? len : next;
  }

  return out;
}

/** Locate `>` that closes a tag, ignoring `>` inside attribute quotes. */
function findTagEnd(s: string, from: number): number {
  let i = from;
  let quote = "";
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
    i++;
  }
  return -1;
}

/** Find the matching `</tag>` for a non-allowed tag we want to strip whole. */
function findCloseTag(s: string, from: number, tagName: string): number {
  const re = new RegExp(`</\\s*${tagName}\\s*>`, "i");
  re.lastIndex = from;
  const m = re.exec(s.slice(from));
  if (!m) return -1;
  return from + (m.index + m[0].length);
}

/** Parse `name="value" name='value' name=value name` into [name,value] pairs. */
function parseAttrs(s: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!name) continue;
    out.push([name, decodeEntities(value)]);
  }
  return out;
}

/**
 * Decode the HTML character references a browser would decode while parsing
 * an attribute value: a small set of named entities, hex numeric (`&#xHH;`),
 * and decimal numeric (`&#NN;`). Must run **before** any URL-scheme check
 * so that `&#x6A;avascript:` collapses to `javascript:` and is denied.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&Tab;/gi, "\t")
    .replace(/&NewLine;/gi, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function safeFromCode(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  // Skip surrogates — they don't carry meaning on their own and are a known
  // mojibake / smuggling vector.
  if (n >= 0xd800 && n <= 0xdfff) return "";
  return String.fromCodePoint(n);
}

/**
 * Strip the bytes a browser ignores while extracting a URL scheme: TAB
 * (U+0009), LF (U+000A), CR (U+000D), plus zero-width and bidi-override
 * characters that some browsers also remove during URL parsing.
 */
const URL_STRIPPABLE_CODES = new Set<number>([
  0x09, 0x0a, 0x0d,
  0x200b, 0x200c, 0x200d,
  0x2028, 0x2029,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0xfeff,
]);
function stripUrlControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && URL_STRIPPABLE_CODES.has(cp)) continue;
    out += ch;
  }
  return out;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
