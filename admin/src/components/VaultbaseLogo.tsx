import React from "react";

/**
 * Vaultbase brand mark — lowercase "vb" monogram built from the wordmark's
 * own v and b (see GUIDELINES.md in the shared vaultbase-sh/brand folder).
 * Drawn on a 256-unit canvas.
 *
 * Below 32 px it switches to the small cut (heavier stroke, tighter bowl) so
 * the counter stays open in the sidebar and on the login screen.
 *
 * Fill resolves from `--accent`, so an operator who reskins the admin via
 * Settings → Theme gets a logo that follows their palette automatically.
 * The previous cube mark is archived in vaultbase-sh/brand/legacy/.
 */
const REGULAR =
  "M34 81.95H61.93L104.9 175.71V210.87H93.09ZM93.09 38.98H116.72V210.87H93.09Z" +
  "M222 146.41A64.46 66.61 0 1 1 93.09 146.41A64.46 66.61 0 1 1 222 146.41Z" +
  "M198.37 146.41A40.82 42.97 0 1 0 116.72 146.41A40.82 42.97 0 1 0 198.37 146.41Z";

const SMALL =
  "M20 75.39H60.84L105.17 172.1V223.51H87.89ZM87.89 26.02H122.45V223.51H87.89Z" +
  "M236 149.45A74.06 76.53 0 1 1 87.89 149.45A74.06 76.53 0 1 1 236 149.45Z" +
  "M201.44 149.45A39.5 41.97 0 1 0 122.45 149.45A39.5 41.97 0 1 0 201.44 149.45Z";

export const VaultbaseLogo: React.FC<{ size?: number; style?: React.CSSProperties }> = ({
  size = 22,
  style,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    style={style}
    aria-label="Vaultbase"
    role="img"
  >
    <path d={size < 32 ? SMALL : REGULAR} fill="var(--accent)" />
  </svg>
);

/**
 * Drawn "vaultbase" wordmark (brand/svg/vaultbase-wordmark.svg). The brand
 * guidelines forbid setting the name in a font next to the mark, so screens
 * that pair symbol + name use this. Fill is `currentColor`; minimum width is
 * 72 px (height ≥ 14).
 */
const WORDMARK =
  "M0 80H26L55 143L84 80H110L55 203ZM242 140A60 62 0 1 1 122 140A60 62 0 1 1 242 140Z" +
  "M220 140A38 40 0 1 0 144 140A38 40 0 1 0 220 140ZM220 80H242V200H220ZM258 80H280V140H258Z" +
  "M356 80H378V200H356ZM378 140A60 62 0 0 1 258 140L280 140A38 40 0 0 0 356 140ZM394 40H416V200H394Z" +
  "M446 50H468V200H446ZM405 81H494V101H405ZM510 40H532V200H510ZM630 140A60 62 0 1 1 510 140A60 62 0 1 1 630 140Z" +
  "M608 140A38 40 0 1 0 532 140A38 40 0 1 0 608 140ZM766 140A60 62 0 1 1 646 140A60 62 0 1 1 766 140Z" +
  "M744 140A38 40 0 1 0 668 140A38 40 0 1 0 744 140ZM744 80H766V200H744Z" +
  "M826 151A44 35.5 0 1 1 862.04 95.14L844.02 107.76A22 13.5 0 1 0 826 129Z" +
  "M826 129A44 35.5 0 1 1 789.96 184.86L807.98 172.24A22 13.5 0 1 0 826 151Z" +
  "M987.96 179.85A60 62 0 1 1 1002 140L980 140A38 40 0 1 0 971.11 165.71ZM883 130H1002V150H883Z";

export const VaultbaseWordmark: React.FC<{ height?: number; className?: string }> = ({
  height = 15,
  className,
}) => (
  <svg
    height={height}
    width={Math.round((height * 1042) / 204)}
    viewBox="-20 20 1042 204"
    className={className}
    aria-label="Vaultbase"
    role="img"
  >
    <path d={WORDMARK} fill="currentColor" />
  </svg>
);

export default VaultbaseLogo;
