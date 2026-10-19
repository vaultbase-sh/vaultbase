/**
 * Theme override loader. Hits the public `/api/v1/admin/theme` endpoint at
 * boot, then injects a `<style id="vb-theme">` block that overrides any
 * supported CSS custom property at the `:root` level.
 *
 * The shape returned by the API maps the *short* variable name to the
 * value (e.g. `accent` not `--accent`). Anything outside the allow-list
 * is dropped so a stray settings key can't inject `*` selectors or other
 * declarations.
 */
/**
 * Each setting sets the older variable (`accent` → `--accent`) and the
 * `--vb-*` tokens the current design reads; setting only the older ones left
 * most of the UI unchanged.
 */
const VAR_MAP: Record<string, string[]> = {
  accent:         ["--accent", "--vb-accent"],
  accent_hover:   ["--accent-hover", "--vb-accent-h"],
  accent_light:   ["--accent-light"],
  bg_app:         ["--bg-app", "--vb-bg-0"],
  bg_sidebar:     ["--bg-sidebar", "--vb-bg-2"],
  bg_panel:       ["--bg-panel", "--vb-bg-1"],
  bg_code:        ["--bg-code"],
  bg_input:       ["--bg-input", "--vb-bg-3"],
  text_primary:   ["--text-primary", "--vb-fg"],
  text_secondary: ["--text-secondary", "--vb-fg-2", "--vb-fg-3"],
  text_tertiary:  ["--text-tertiary", "--vb-fg-4"],
  text_muted:     ["--text-muted", "--vb-fg-5"],
  success:        ["--success", "--vb-status-success"],
  warning:        ["--warning", "--vb-status-warning"],
  danger:         ["--danger", "--vb-status-danger"],
  info:           ["--info"],
};

const STYLE_ID = "vb-theme-overrides";

/** RegExp matching a permissive CSS color literal — hex, rgb(), hsl(), oklch(), color(), or a named keyword. */
const COLOR_RE = /^(#(?:[0-9a-fA-F]{3,8})|(?:rgba?|hsla?|oklch|color)\([^;{}<>]+\)|[a-zA-Z]+)$/;

function isSafeColor(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 64) return false;
  return COLOR_RE.test(v);
}

/** The CSS variables a set of theme settings overrides. Unknown keys and unsafe values are dropped. */
export function themeVars(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [shortName, raw] of Object.entries(overrides)) {
    const vars = VAR_MAP[shortName];
    const value = raw.trim();
    if (!vars || !isSafeColor(value)) continue;
    for (const v of vars) out[v] = value;
    if (shortName === "accent") out["--primary-color"] = value;
    if (shortName === "accent_hover") out["--vb-accent-hover"] = value;
    if (shortName === "accent") {
      out["--vb-accent-soft"] = `color-mix(in srgb, ${value} 16%, transparent)`;
      out["--accent-soft"] = `color-mix(in srgb, ${value} 12%, transparent)`;
      out["--accent-soft-2"] = `color-mix(in srgb, ${value} 18%, transparent)`;
    }
  }
  return out;
}

export function applyTheme(overrides: Record<string, string>): void {
  // The sidebar, dashboard and sign-in page redefine some tokens on their own
  // root element, so the overrides go there too.
  let css = ":root, .sidebar--next, .vb-dash, .vb-auth {";
  for (const [name, value] of Object.entries(themeVars(overrides))) css += `${name}:${value};`;
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
    const res = await fetch("/api/v1/admin/theme", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json() as { data?: Record<string, string> };
    if (body.data) applyTheme(body.data);
  } catch {
    /* offline / first-run before server up — fall back to default theme */
  }
}
