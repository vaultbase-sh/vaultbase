import React from "react";

/**
 * Vaultbase brand mark — hexagonal vault, three-quarters view, coral palette.
 * Drawn on a 32-unit grid; coloring follows the v0.9 redesign accent (coral)
 * with brighter highlight + darker spine + cream chevron.
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
      fill="#e85a4f"
      stroke="#f0807a"
      strokeWidth="0.8"
    />
    <path d="M16 3 5 9l11 6 11-6L16 3Z" fill="#f0807a" opacity="0.9" />
    <path d="M16 15v14" stroke="#7a2620" strokeWidth="1" opacity="0.55" />
    <path
      d="m11 13 5 3 5-3"
      stroke="#ffe8d6"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.95"
    />
  </svg>
);

export default VaultbaseLogo;
