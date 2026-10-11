/**
 * The 32px Vaultbase mark both auth boards draw in the card header, rather
 * than the wordmark lockup the signed-in chrome uses.
 */
export default function AuthMark() {
  return (
    <svg
      className="vb-auth__mark"
      width="32"
      height="32"
      viewBox="0 0 256 256"
      role="img"
      aria-label="Vaultbase"
    >
      <g transform="translate(-17.66 -15.89) scale(1.138)">
        <path
          fill="#F06F64"
          d="M 20.00 75.39 H 60.84 L 105.17 172.10 V 223.51 H 87.89ZM 87.89 26.02 H 122.45 V 223.51 H 87.89ZM 236.00 149.45 A 74.06 76.53 0 1 1 87.89 149.45 A 74.06 76.53 0 1 1 236.00 149.45ZM 201.44 149.45 A 39.50 41.97 0 1 0 122.45 149.45 A 39.50 41.97 0 1 0 201.44 149.45Z"
        />
      </g>
    </svg>
  );
}
