/**
 * Theme override loader. Hits the public `/api/admin/theme` endpoint at
 * boot, then injects a `<style id="vb-theme">` block that overrides any
 * supported CSS custom property at the `:root` level.
 *
 * The shape returned by the API maps the *short* variable name to the
 * value (e.g. `accent` not `--accent`). Anything outside the allow-list
 * is dropped so a stray settings key can't inject `*` selectors or other
 * declarations.
 */
const ALLOWED_VARS = new Set<string>([
  "accent", "accent_hover", "accent_light",
  "bg_app", "bg_sidebar", "bg_panel", "bg_code", "bg_input",
  "text_primary", "text_secondary", "text_tertiary", "text_muted",
  "success", "warning", "danger", "info",
]);

const STYLE_ID = "vb-theme-overrides";

/** RegExp matching a permissive CSS color literal — hex, rgb(), hsl(), oklch(), color(), or a named keyword. */
const COLOR_RE = /^(#(?:[0-9a-fA-F]{3,8})|(?:rgba?|hsla?|oklch|color)\([^;{}<>]+\)|[a-zA-Z]+)$/;

function isSafeColor(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 64) return false;
  return COLOR_RE.test(v);
}

export function applyTheme(overrides: Record<string, string>): void {
  let css = ":root {";
  for (const [shortName, value] of Object.entries(overrides)) {
    if (!ALLOWED_VARS.has(shortName)) continue;
    if (!isSafeColor(value)) continue;
    const cssName = `--${shortName.replace(/_/g, "-")}`;
    css += `${cssName}:${value};`;
  }
  css += "}";

  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export async function applyThemeOverrides(): Promise<void> {
  try {
    const res = await fetch("/api/admin/theme", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json() as { data?: Record<string, string> };
    if (body.data) applyTheme(body.data);
  } catch {
    /* offline / first-run before server up — fall back to default theme */
  }
}
