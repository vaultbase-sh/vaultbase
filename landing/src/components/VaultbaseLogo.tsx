import type { CSSProperties } from "react";

/**
 * Vaultbase brand mark — hexagonal vault, three-quarters view.
 * Drawn on a 32-unit grid per the brand & design system v1.0.
 */
export const VaultbaseLogo: React.FC<{ size?: number; style?: CSSProperties }> = ({
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
      fill="#3b82f6"
      stroke="#60a5fa"
      strokeWidth="0.8"
    />
    <path d="M16 3 5 9l11 6 11-6L16 3Z" fill="#60a5fa" opacity="0.85" />
    <path d="M16 15v14" stroke="#1e3a8a" strokeWidth="1" opacity="0.6" />
    <path
      d="m11 13 5 3 5-3"
      stroke="#bfdbfe"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.95"
    />
  </svg>
);
