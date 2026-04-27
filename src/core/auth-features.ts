import { getAllSettings } from "../api/settings.ts";

export type AuthFeature = "otp" | "mfa" | "anonymous" | "impersonation";

/** Defaults chosen for safety: opt-in for anything that broadens access. */
const DEFAULTS: Record<AuthFeature, boolean> = {
  otp: false,
  mfa: true,
  anonymous: false,
  impersonation: true,
};

export function isAuthFeatureEnabled(feature: AuthFeature): boolean {
  const key = `auth.${feature}.enabled`;
  const raw = getAllSettings()[key];
  if (raw === undefined) return DEFAULTS[feature];
  return raw === "1" || raw === "true";
}

export const AUTH_FEATURE_DEFAULTS = DEFAULTS;
