/**
 * Server version. Used by the update checker and the /api/v1/admin/update-status
 * endpoint to compare against GitHub's latest release tag.
 *
 * Bump in lockstep with `package.json` version + the git tag.
 */
export const VAULTBASE_VERSION = "0.11.2";
