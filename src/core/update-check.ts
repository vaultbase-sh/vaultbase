/**
 * Polls GitHub for the latest release tag and caches the result in
 * `vaultbase_settings`. The admin UI reads `/api/admin/update-status` to
 * surface a banner when a new version is available.
 *
 * Settings keys written:
 *   - `update_check.latest_version`   "v0.1.6"
 *   - `update_check.checked_at`       unix-seconds
 *   - `update_check.error`            last error (cleared on success)
 *
 * Setting key read:
 *   - `update_check.enabled`          "1" / "0", default "1"
 *
 * Polling cadence: once at boot (after a 30s delay so the server is up),
 * then every 6 hours. Cancelled when `enabled` flips to "0" — re-enabled
 * by toggling back on (next boot or a settings save).
 */
import { getSetting, setSetting } from "../api/settings.ts";
import { VAULTBASE_VERSION } from "./version.ts";

const REPO = "vaultbase-sh/vaultbase";
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_DELAY_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;

export interface UpdateStatus {
  current_version: string;
  latest_version: string | null;
  checked_at: number | null;
  enabled: boolean;
  update_available: boolean;
  last_error: string | null;
}

/**
 * Naive semver-ish comparator. Strips a leading "v" + compares dot-separated
 * integers. Returns 1 if `a > b`, -1 if `a < b`, 0 if equal. Handles trailing
 * pre-release suffixes by ignoring everything after the first `-`.
 */
function compareVersions(a: string, b: string): number {
  const norm = (s: string) => s.replace(/^v/, "").split("-")[0] ?? "";
  const pa = norm(a).split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = norm(b).split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export async function runUpdateCheck(): Promise<void> {
  if (getSetting("update_check.enabled", "1") !== "1") return;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "vaultbase-update-check" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      setSetting("update_check.error", `GitHub ${res.status}`);
      return;
    }
    const body = await res.json() as { tag_name?: string };
    const tag = (body.tag_name ?? "").trim();
    if (!tag) {
      setSetting("update_check.error", "no tag_name in response");
      return;
    }
    setSetting("update_check.latest_version", tag);
    setSetting("update_check.checked_at", String(Math.floor(Date.now() / 1000)));
    setSetting("update_check.error", "");
  } catch (e) {
    setSetting("update_check.error", e instanceof Error ? e.message : String(e));
  }
}

export function startUpdateCheckScheduler(): void {
  stopUpdateCheckScheduler();
  if (getSetting("update_check.enabled", "1") !== "1") return;
  firstTimer = setTimeout(() => { void runUpdateCheck(); }, FIRST_DELAY_MS);
  timer = setInterval(() => { void runUpdateCheck(); }, POLL_INTERVAL_MS);
}

export function stopUpdateCheckScheduler(): void {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export function getUpdateStatus(): UpdateStatus {
  const enabled = getSetting("update_check.enabled", "1") === "1";
  const latest = getSetting("update_check.latest_version", "") || null;
  const checkedAtRaw = getSetting("update_check.checked_at", "");
  const checked_at = checkedAtRaw ? Number.parseInt(checkedAtRaw, 10) : null;
  const last_error = getSetting("update_check.error", "") || null;
  const update_available =
    enabled && latest !== null && compareVersions(latest, VAULTBASE_VERSION) > 0;
  return {
    current_version: VAULTBASE_VERSION,
    latest_version: latest,
    checked_at,
    enabled,
    update_available,
    last_error,
  };
}
