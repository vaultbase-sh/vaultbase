# Vaultbase landing

Static React + Tailwind v4 SPA. Vite build, no runtime.

## Local dev

```bash
bun install
bun run dev          # vite on :5173
bun run build        # static output → ./dist
bun run preview      # serve ./dist locally
```

## Deploy

The `dist/` folder is a plain static bundle. Serve it from any static host.

### Cloudflare Pages

1. Connect the repo, set **Build command** to `bun install && bun run build`.
2. Set **Build output directory** to `landing/dist`.
3. Set **Root directory** to `landing`.
4. SPA fallback + caching headers come from `public/_redirects` + `public/_headers`.

### Netlify

`netlify.toml` is wired. Either:
- Point Netlify at the `landing/` subfolder via UI, or
- Add a top-level `netlify.toml` that sets `base = "landing"`.

### Vercel

`vercel.json` is wired. In the Vercel UI set the **Root Directory** to
`landing/`. Build command auto-detects.

### Docker / VPS

```bash
cd landing
docker build -t vaultbase-landing .
docker run -p 80:80 vaultbase-landing
```

The image is multi-stage (Bun build → nginx serve) and exposes port 80 with
a SPA fallback in `nginx.conf`. Total image size ≈ 50 MB.

### Generic static host (S3 + CloudFront, GitHub Pages, etc.)

1. `bun run build`.
2. Upload `dist/` to the bucket / publish branch.
3. Configure SPA fallback so every unmatched path serves `index.html`
   (CloudFront error 404 → `/index.html` 200, GitHub Pages with a copy
   `dist/404.html` ← `dist/index.html`).

## Caching

- `/assets/*` is content-hashed, served `public, max-age=31536000, immutable`.
- Everything else is `no-cache, must-revalidate` (or short TTL on
  Netlify/Vercel/CF) so deploys land instantly.
