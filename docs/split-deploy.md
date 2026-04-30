# Splitting landing + docs into separate repos

This is the option-B workflow: extract `landing/` and `site/` into their own
git repos, deploy each to its own Cloudflare Pages project.

The split has already been run locally — two branches now exist:

```
landing-only   →  contents of landing/   at repo root
docs-only      →  contents of site/      at repo root
```

Verify before pushing:

```bash
git log landing-only --oneline | head
git log docs-only --oneline | head
git ls-tree --name-only landing-only
git ls-tree --name-only docs-only
```

## 1. Create the GitHub repos

Two empty repos, no README / no license — pick the names you want:

- `vaultbase-landing` (or `vaultbase/landing`)
- `vaultbase-docs` (or `vaultbase/docs`)

## 2. Push the split branches

```bash
# Landing
git remote add landing-origin git@github.com:<user>/vaultbase-landing.git
git push landing-origin landing-only:main

# Docs
git remote add docs-origin git@github.com:<user>/vaultbase-docs.git
git push docs-origin docs-only:main
```

After this lands on GitHub, both repos have `main` populated with their
own focused history.

## 3. Wire Cloudflare Pages

For each repo, create a CF Pages project pointed at the repo's root:

### Landing (vaultbase-landing)

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | `bun install && bun run build` |
| Build output directory | `dist` |
| Root directory | (blank) |
| Build system version | 2 |

The repo includes `public/_redirects` (SPA fallback) and `public/_headers`
(caching + security) — Cloudflare reads them as-is.

### Docs (vaultbase-docs)

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | Astro |
| Build command | `bun install && bun run build` |
| Build output directory | `dist` |
| Root directory | (blank) |
| Build system version | 2 |

`public/_headers` ships with the repo.

## 4. Custom domains (optional)

In each Pages project, add a custom hostname:

- `vaultbase.dev` → vaultbase-landing
- `docs.vaultbase.dev` → vaultbase-docs

Cloudflare auto-issues TLS. Update DNS records (CNAME apex via flattening,
or a worker route).

`site/astro.config.mjs` sets `site: "https://vaultbase.dev"` — change this
to `https://docs.vaultbase.dev` when shipping docs to its own subdomain so
canonical URLs + sitemap reflect the real origin.

## 5. Keeping splits in sync (re-running later)

When `landing/` or `site/` changes in the monorepo, re-split + push:

```bash
# Landing
git subtree split -P landing -b landing-only --rejoin
git push landing-origin landing-only:main

# Docs
git subtree split -P site -b docs-only --rejoin
git push docs-origin docs-only:main
```

The `--rejoin` flag merges the split commit back into `main` so subsequent
splits are incremental, not full re-walks.

## 6. Going forward

Once split repos exist, the deploy story is:

- Push to monorepo `main` → no auto-deploy (CF Pages isn't watching this repo)
- Run the two `git subtree split --rejoin` + `git push` commands → CF Pages
  picks up each repo's new `main` and rebuilds in parallel
- Or commit + push directly to `vaultbase-landing` / `vaultbase-docs`
  bypassing the monorepo when you only need to tweak one surface

Wrap the publish flow in a Makefile or shell script if it gets repetitive:

```bash
#!/usr/bin/env bash
# scripts/publish-web.sh
set -e
git subtree split -P landing -b landing-only --rejoin
git subtree split -P site    -b docs-only    --rejoin
git push landing-origin landing-only:main
git push docs-origin    docs-only:main
echo "✓ landing + docs published — CF Pages building"
```

## What stays in the monorepo

`landing/` and `site/` are now sources-of-truth in two places — the
monorepo (where you edit) and the split repos (where CF Pages reads). That
is the cost of clean separation. If you'd rather keep one source of truth
and let CF Pages monitor only specific paths, see option A in the deploy
discussion (single repo, two CF Pages projects, Build Watch Paths).
