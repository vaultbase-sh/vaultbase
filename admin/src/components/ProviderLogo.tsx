import React from "react";

// Simplified brand marks — single fill where possible, multi-fill when the
// recognizable mark requires it. Sized via the `size` prop; viewBox baked into
// each SVG so they all render at the same visual scale.

interface ProviderLogoProps {
  provider: string;
  size?: number;
  style?: React.CSSProperties;
}

const SVG_BY_PROVIDER: Record<string, (size: number) => React.ReactNode> = {
  google: (s) => (
    <svg width={s} height={s} viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.5 29.3 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.1 18.9 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.5 29.3 4.5 24 4.5 16.3 4.5 9.7 8.7 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 43.5c5.2 0 9.9-2 13.5-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.3 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.2 16.2 43.5 24 43.5z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.2 5.2c-.4.4 6.6-4.8 6.6-14.9 0-1.2-.1-2.4-.4-3.5z"/>
    </svg>
  ),
  github: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.3-3.2-.1-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>
    </svg>
  ),
  gitlab: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#E24329" d="M12 21.5l3.7-11.4H8.3z"/>
      <path fill="#FCA326" d="M12 21.5l-3.7-11.4H3.1z"/>
      <path fill="#E24329" d="M3.1 10.1L2 13.6c-.1.4 0 .8.3 1l9.7 7-8.9-11.5z"/>
      <path fill="#FC6D26" d="M3.1 10.1h5.2L6.1 3.3c-.1-.3-.6-.3-.7 0z"/>
      <path fill="#FCA326" d="M12 21.5l3.7-11.4H21z"/>
      <path fill="#E24329" d="M21 10.1l1.1 3.5c.1.4 0 .8-.3 1L12 21.5l8.9-11.5z"/>
      <path fill="#FC6D26" d="M21 10.1h-5.2L18 3.3c.1-.3.6-.3.7 0z"/>
    </svg>
  ),
  facebook: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#1877F2" d="M22 12a10 10 0 1 0-11.6 9.9V14.9H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12"/>
    </svg>
  ),
  microsoft: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <rect x="2" y="2"  width="9" height="9" fill="#F25022"/>
      <rect x="13" y="2" width="9" height="9" fill="#7FBA00"/>
      <rect x="2" y="13" width="9" height="9" fill="#00A4EF"/>
      <rect x="13" y="13" width="9" height="9" fill="#FFB900"/>
    </svg>
  ),
  discord: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#5865F2" d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.4a18 18 0 0 0-6.4 0L8.6 3a19.8 19.8 0 0 0-5 1.4C.5 9.2-.3 13.8.1 18.4a20 20 0 0 0 6 3l.5-.7a14 14 0 0 1-2.3-1.1l.6-.4a14.2 14.2 0 0 0 12.2 0l.6.4a14 14 0 0 1-2.3 1.1l.5.7a20 20 0 0 0 6-3c.4-5.5-.6-10-3.6-14zM8 15.4c-1.2 0-2.2-1.1-2.2-2.5S6.7 10.4 8 10.4s2.2 1.1 2.2 2.5S9.2 15.4 8 15.4zm8 0c-1.2 0-2.2-1.1-2.2-2.5s1-2.5 2.2-2.5 2.2 1.1 2.2 2.5-1 2.5-2.2 2.5z"/>
    </svg>
  ),
  twitch: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#9146FF" d="M3.4 2L2 5.7v15h5v3h3l3-3h4l5.5-5.5V2H3.4zm17.1 12.5L18 17h-5l-3 3v-3H6V3.5h14.5v11zM18 7.5v5h-2v-5h2zm-5 0v5h-2v-5h2z"/>
    </svg>
  ),
  spotify: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#1DB954" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.6 14.4c-.2.3-.6.4-.9.2-2.5-1.5-5.7-1.9-9.4-1-.4.1-.7-.2-.8-.5-.1-.4.2-.7.5-.8 4.1-.9 7.6-.5 10.4 1.2.4.2.4.6.2.9zm1.2-2.7c-.3.4-.7.5-1.1.3-2.9-1.8-7.3-2.3-10.7-1.3-.4.1-.9-.1-1-.6-.1-.4.1-.9.6-1 4-1.2 8.8-.6 12.1 1.4.4.3.5.8.1 1.2zm.1-2.8C14.5 8.8 8.6 8.6 5.3 9.6c-.5.2-1.1-.1-1.3-.7-.2-.5.1-1.1.7-1.3 3.8-1.2 10.4-.9 14.5 1.5.5.3.7 1 .4 1.5-.4.5-1.1.7-1.7.3z"/>
    </svg>
  ),
  linkedin: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#0A66C2" d="M20.5 2h-17C2.7 2 2 2.7 2 3.5v17c0 .8.7 1.5 1.5 1.5h17c.8 0 1.5-.7 1.5-1.5v-17c0-.8-.7-1.5-1.5-1.5zM8 19H5V9h3v10zM6.5 7.7a1.7 1.7 0 1 1 0-3.5 1.7 1.7 0 0 1 0 3.5zM19 19h-3v-5c0-1.2 0-2.7-1.6-2.7s-1.9 1.3-1.9 2.6V19h-3V9h2.9v1.4h.1c.4-.8 1.4-1.6 2.9-1.6 3.1 0 3.7 2 3.7 4.7V19z"/>
    </svg>
  ),
  slack: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#E01E5A" d="M5.5 14.5a2 2 0 1 1-2-2h2v2zM6.5 14.5a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5z"/>
      <path fill="#36C5F0" d="M9.5 5.5a2 2 0 1 1 2-2v2h-2zM9.5 6.5a2 2 0 0 1 0 4h-5a2 2 0 1 1 0-4h5z"/>
      <path fill="#2EB67D" d="M18.5 9.5a2 2 0 1 1 2 2h-2v-2zM17.5 9.5a2 2 0 0 1-4 0v-5a2 2 0 1 1 4 0v5z"/>
      <path fill="#ECB22E" d="M14.5 18.5a2 2 0 1 1-2 2v-2h2zM14.5 17.5a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5z"/>
    </svg>
  ),
  bitbucket: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <path fill="#2684FF" d="M2.7 3.5a.6.6 0 0 0-.6.7L5 21.3a.7.7 0 0 0 .7.6h12.6a.6.6 0 0 0 .6-.5l2.9-17.1a.6.6 0 0 0-.6-.7H2.7zm11.7 11.6h-4.7L8.4 8.8h7l-1 6.3z"/>
    </svg>
  ),
  notion: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.5 2.4c.6.5 1 .6 2.2.5l11.4-.7c.2 0 .1-.3-.1-.3L16 1c-.4-.3-.9-.6-1.9-.5L3.4 1.3c-.5 0-.5.3-.4.4l1.5 1.7zm.4 1.6V16c0 .7.4.9 1.2.9l11.4-.7c.7 0 .8-.5.8-1V4.4c0-.5-.2-.7-.6-.7L5.7 4.3c-.5 0-.7.3-.7.7v-1zm12 .8c.1.4 0 .7-.4.8l-.6.1v8c-.5.3-.9.4-1.3.4-.6 0-.8-.2-1.3-.7L9.4 8v5l1 .3s0 .6-.7.6l-2 .1c-.1-.1 0-.5.3-.5l.5-.2V5.4l-.7-.1c-.1-.4.1-.9.7-.9l2.1-.1L15 11.3V5.7l-.9-.1c-.1-.5.2-.8.6-.9l1.9-.1z"/>
    </svg>
  ),
  patreon: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <circle cx="15.4" cy="9.4" r="6.4" fill="#FF424D"/>
      <rect x="3" y="3" width="3.5" height="18" fill="#000"/>
    </svg>
  ),
};

export default function ProviderLogo({ provider, size = 18, style }: ProviderLogoProps) {
  const render = SVG_BY_PROVIDER[provider];
  if (!render) {
    // Fallback: a neutral circle with the first letter
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size, height: size,
          borderRadius: "50%",
          background: "var(--accent-glow, rgba(16,85,201,0.2))",
          color: "var(--accent-light, #4d8ce8)",
          fontSize: size * 0.6,
          fontWeight: 600,
          ...style,
        }}
      >
        {provider[0]?.toUpperCase()}
      </span>
    );
  }
  return <span style={{ display: "inline-flex", lineHeight: 0, ...style }}>{render(size)}</span>;
}
