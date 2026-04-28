# Vaultbase docs

Astro Starlight static site. Multi-page, no client runtime beyond Starlight's defaults.

## Local dev

```bash
bun install
bun run dev          # astro dev on :4321
bun run build        # static output → ./dist
bun run preview      # serve ./dist locally
```

## Deploy

The `dist/` folder is fully static — every route is its own HTML file. No
SPA fallback needed (and no fallback configured — unmatched paths surface a
real 404).

### Cloudflare Pages

1. Connect the repo, set **Build command** to `bun install && bun run build`.
2. Set **Build output directory** to `site/dist`.
3. Set **Root directory** to `site`.
4. Caching headers come from `public/_headers`.

### Netlify

`netlify.toml` is wired. Either point Netlify at the `site/` subfolder via
the UI, or add a top-level `netlify.toml` setting `base = "site"`.

### Vercel

`vercel.json` is wired with `framework: "astro"`. Set the **Root Directory**
to `site/` in the Vercel UI.

### Docker / VPS

```bash
cd site
docker build -t vaultbase-docs .
docker run -p 80:80 vaultbase-docs
```

Multi-stage (Bun build → nginx serve), exposes port 80. nginx serves
`/index.html` at `/`, `/<route>/index.html` at `/<route>`, falls through to
`<path>.html`, then 404.html.

### GitHub Pages

```bash
bun run build
# publish ./dist on the gh-pages branch (or via Actions)
```

If publishing to `<user>.github.io/<repo>/`, add a `base` to `astro.config.mjs`.

## Caching

- `/_astro/*` is content-hashed, served `public, max-age=31536000, immutable`.
- HTML pages are `no-cache, must-revalidate` (or short TTL on the host) so
  updates land instantly.

## Site URL

`astro.config.mjs` sets `site: "https://vaultbase.dev"`. Change this when
deploying to a different host so `<link rel="canonical">` and the sitemap
reflect the real origin.
