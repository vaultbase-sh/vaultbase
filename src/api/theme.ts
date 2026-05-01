/**
 * Public theme endpoint. Returns the admin's CSS variable overrides so the
 * SPA can inject them as inline `:root { --accent: ... }` at boot — even
 * before the user is signed in (login page picks them up too).
 *
 * Public on purpose: theme is presentation-only. Stored in `vaultbase_settings`
 * under `theme.<var>` keys; missing = use SPA default. Saving lives behind
 * admin auth via the regular `PATCH /api/admin/settings`.
 */
import Elysia from "elysia";
import { getAllSettings } from "./settings.ts";

const THEME_PREFIX = "theme.";

export function makeThemePlugin() {
  return new Elysia({ name: "theme" })
    .get("/api/admin/theme", () => {
      const all = getAllSettings();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(THEME_PREFIX)) continue;
        if (typeof v !== "string" || !v) continue;
        out[k.slice(THEME_PREFIX.length)] = v;
      }
      return { data: out };
    });
}
