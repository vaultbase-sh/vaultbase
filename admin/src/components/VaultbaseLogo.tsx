import React from "react";

/**
 * Vaultbase brand mark — hexagonal vault, three-quarters view.
 * Drawn on a 32-unit grid. All colors resolve from theme tokens so an
 * operator who reskins the admin via Settings → Theme (override of
 * `--accent`, `--accent-light`, `--bg-app`, `--text-primary`) gets a logo
 * that follows their palette automatically.
 *
 *   body fill       → --accent
 *   body stroke /
 *     top face      → --accent-light
 *   spine           → --bg-app (page bg, gives a "carved" look)
 *   chevron         → --text-primary
 */
export const VaultbaseLogo: React.FC<{ size?: number; style?: React.CSSProperties }> = ({
  size = 22,
  style,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    style={style}
    aria-label="Vaultbase"
    role="img"
  >
    <path
      d="M16 3 5 9v14l11 6 11-6V9L16 3Z"
      fill="var(--accent)"
      stroke="var(--accent-light)"
      strokeWidth="0.8"
    />
    <path
      d="M16 3 5 9l11 6 11-6L16 3Z"
      fill="var(--accent-light)"
      opacity="0.9"
    />
    <path
      d="M16 15v14"
      stroke="var(--bg-app)"
      strokeWidth="1"
      opacity="0.55"
    />
    <path
      d="m11 13 5 3 5-3"
      stroke="var(--text-primary)"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.95"
    />
  </svg>
);

export default VaultbaseLogo;
