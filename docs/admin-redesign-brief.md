# Vaultbase admin — full UI redesign brief

A briefing document for producing a complete, internally-consistent set of
redesigns covering every screen and component in the admin panel. Goal: ship
one coherent visual language that we can roll out across the entire
workspace in a single pass, instead of patching pages one at a time.

---

## What "the admin" is

`http://<host>:<port>/_/` — a React 19 + Vite SPA bundled into the server
binary. It's the only first-party UI for managing a Vaultbase install:
collections, records, auth, hooks, settings, logs. Everything an operator
or developer needs lives here. Power users will spend hours a day in it,
mostly editing schemas, writing server-side JS, and inspecting requests.

It is **not** a marketing surface. Density matters. Information per
viewport matters. Mouse + keyboard are first-class; touch is incidental.

---

## What's there now (inventory)

### Persistent shell

- **Sidebar** (220px, dark, sticky) — brand mark + wordmark, three sections
  (Data / Auth / System), nav items, footer with admin pill
- **Topbar** (56px) — page title, optional subtitle, optional back
  button, action buttons aligned right

### Pages (12)

1. **Setup** (`/_/setup`) — first-run wizard, creates the seed admin
   account
2. **Login** (`/_/login`) — admin login form; centered card on a radial
   gradient background
3. **Dashboard** (`/_/`) — landing screen, currently a stat-card grid
4. **Collections list** (`/_/collections`) — list of collections with
   counts, filters by type (`base` / `auth` / `view`), create button
5. **Collection edit** (`/_/collections/:id`) — schema editor; tabbed
   layout (Fields / API Rules / Indexes); already redesigned recently
6. **Records list** (`/_/collections/:id/records`) — paginated record
   table, filters via expression bar, inline edit, bulk select, drawer
   for create/edit, CSV import/export, batch actions
7. **API preview** (`/_/api-preview`) — live REST playground; pick a
   collection, build a request (filter, sort, expand, fields, paging),
   send, render JSON response
8. **Logs** (`/_/logs`) — request log viewer, JSONPath search, filter
   bar, row inspector with rule-eval breakdown
9. **Hooks** (`/_/hooks`) — five sub-tabs: Record hooks · Custom routes ·
   Cron jobs · Workers · Jobs log. Each has a list table + a Monaco code
   editor modal with typed `ctx` autocomplete
10. **API tokens** (`/_/tokens`) — token issue + list (placeholder for now)
11. **Superusers** (`/_/users`) — admin account management (list,
    create, edit, delete)
12. **Settings** (`/_/settings`) — multi-tab: general, auth features,
    OAuth2 providers, SMTP, file storage (local / S3 / R2), rate
    limiting, encryption, backup/restore, migrations

### Reusable components

- `CodeEditor` — Monaco wrapper with typed-ctx IntelliSense per surface
  (hook / route / job / worker / SQL)
- `RuleEditor` — single-line rule expression input with autocomplete
  popover (auth refs, fields, operators, literals)
- `Icon` — single-file icon set (~40 lucide-style glyphs, 16px default,
  1.5 stroke)
- `Toggle` — accessible switch
- `FieldTypeChip` — colored pill per schema field type (one of 14)
- `Modal` (PrimeReact Dialog wrapper)
- `Drawer` (PrimeReact Sidebar wrapper, right-anchored, 480px)
- `Toast` (PrimeReact Toast — bottom-right)
- `StatCard` — dashboard stat tile
- `Confirm` — promise-based confirm dialog
- `ProviderLogo` — OAuth2 provider mark
- `VaultbaseLogo` — hexagonal vault mark (recently shipped)

---

## What we want from the redesign

A **complete, coherent set of screen designs** plus the underlying atoms
they're built from. Treat this as a single design pass that sets the
visual tone for the next year of work. The goal is not minor polish —
we want a fresh take that we can implement page by page knowing each
new piece will sit consistently next to the previous one.

Cover, at minimum:

1. **Atoms** — buttons (primary / secondary / ghost / danger / icon),
   inputs (text / mono / number / textarea / select / dropdown / chips /
   toggle / radio / checkbox), badges, type chips, callouts (info /
   success / warning / danger), code blocks, kbd shortcuts, tooltips,
   spinners, empty states, pagination
2. **Composite components** — table (with sticky header, sortable cols,
   inline edit, row actions, bulk select), tab bar, segmented control,
   filter pill, command palette, modal, drawer, dropdown menu, popover,
   side-panel inspector, row drawer, stat card, sparkline, code-editor
   chrome (toolbar + status strip)
3. **Application shell** — sidebar (collapsed + expanded), topbar with
   action zones, page header patterns (back + title + subtitle +
   actions), breadcrumb when relevant
4. **Full-page designs** for every screen listed in the inventory above

If you think a current screen is wrong (or missing), redesign it
honestly. Don't preserve a layout just because we have one. We'd rather
adopt the new design clean than keep a cargo-culted version.

---

## Constraints (non-negotiable)

- **Dark-first.** Light mode is not a goal for v1; design only the dark
  surface. The brand surfaces are #0e0f12 (app), #131418 (sidebar),
  #181a1f (panel), #1d2026 (popover), #14161b (input), #0a0b0e (code).
- **Accent is Blue 500 (#3b82f6).** Used sparingly: selection,
  primary action, focus rings, the active sidebar item.
- **Type system is fixed.** Inter for human language, JetBrains Mono
  for everything technical (names, types, expressions, IDs, section
  labels). Don't introduce a third typeface.
- **14 type-mapped data colors are fixed.** text=#60a5fa,
  number=#34d399, bool=#fbbf24, email=#a78bfa, url=#38bdf8,
  date=#f472b6, password=#fb7185, editor=#c084fc, geoPoint=#4ade80,
  file=#fb923c, relation=#2dd4bf, select=#fde047, json=#94a3b8,
  autodate=#f472b6.
- **Spacing is the 4-point scale.** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.
  No 5px or 10px or 18px gaps — pick a scale step.
- **Radii are limited.** xs=4 / sm=6 / md=8 / lg=12 / pill=999. No
  arbitrary 7px or 14px radii.
- **Borders before shadows.** A 1px hairline (#23262d subtle, #2a2e36
  default, #353a44 strong) is the default separator. Shadows are
  reserved for floating elements (popover, dropdown, modal).
- **Motion is feedback, not theater.** 120ms (hover, color, toggle),
  180ms (panel slide, expand), 260ms (modal enter). Easings:
  cubic-bezier(0.16, 1, 0.30, 1) fast, (0.40, 0, 0.20, 1) standard,
  (0.65, 0, 0.35, 1) slow. No bouncing.
- **PrimeReact is the underlying library.** Don't design components
  that PrimeReact can't realistically theme into existence — if a
  component needs a custom React widget, say so explicitly.
- **Density first.** A power user opens 5 pages a minute. Most of the
  time we want more rows per viewport, not fewer. Avoid airy SaaS-style
  spacing — this is a pro tool.

## Constraints (soft — prefer to honor)

- Single-screen flows where possible. Avoid wizard-style stepping
  through multiple pages when one well-organized page would do.
- Empty states should be useful. The first time you open Hooks, the
  empty state should explain what hooks are and link to docs.
- Inline editing where the data model supports it. Don't always force a
  modal.
- Keyboard shortcuts visible in the UI (e.g., `?` for help, `/` to focus
  search, `cmd+k` for command palette).

---

## Audience and use cases per page

Use this when deciding what to lead with on each screen.

### Setup / Login
- **Audience:** the operator on first run, or returning admins.
- **Goal:** get them to the dashboard in <30 seconds.
- **Don't:** add marketing copy. They've already chosen this product.

### Dashboard
- **Audience:** returning admin glancing at health.
- **Goal:** "is everything fine?" answered in one viewport.
- **Surface:** request rate, error rate, recent failed jobs, slow
  queries, disk usage of the SQLite file + uploads dir, active realtime
  connections, top collections by record count.
- **Don't:** a wall of vanity metrics.

### Collections list
- **Audience:** developer about to model a feature.
- **Goal:** find a collection fast, jump into its records or schema.
- **Surface:** name, type, record count, indexed-at hint, color-coded
  initial avatar.

### Collection edit (schema editor)
- **Audience:** developer designing the data model.
- **Goal:** add/remove/rename fields, configure rules, manage indexes.
- **Already redesigned recently.** New design should align with the V1
  Tabbed layout (Fields / API Rules / Indexes) — don't undo that.

### Records
- **Audience:** developer / support agent inspecting or fixing data.
- **Goal:** find a row, edit a field, run a filter, export.
- **This is the most-used page.** Get this right. Inline edit, virtualized
  scrolling for large tables, column visibility, frozen first column,
  filter expression bar that uses the same syntax as API rules.
- **Surface:** filter pill bar that turns chips into a textual expression
  (`status = "published" AND author.id = "abc"`), bulk actions, CSV
  import/export, row drawer for full edit, hot-keys (j/k navigation,
  enter to edit, esc to cancel).

### API preview
- **Audience:** developer testing the API without leaving the admin.
- **Goal:** craft a request, see the response, copy as curl.
- **Surface:** method + path picker, query builder (filter / sort /
  expand / fields / page / perPage / skipTotal), bearer-token picker,
  send button, syntax-highlighted response viewer with timing,
  copy-as-curl, copy-as-fetch.

### Logs
- **Audience:** developer debugging.
- **Goal:** find a request, understand why a rule allowed/denied it.
- **Surface:** time-range picker, status-class filter, method filter,
  collection filter, JSONPath search, virtualized rows, row inspector
  showing every rule evaluation in order with `outcome`, `reason`, and
  optional `expression`.

### Hooks (five tabs)
- **Audience:** developer writing server-side JS.
- **Goal:** edit code without leaving the admin.
- **Surface:** for each sub-tab, a list table of the existing items,
  plus a full-screen Monaco editor modal. The current modal opens
  maximized — keep it. Show the `ctx` shape inline as a collapsible
  cheat sheet. Show last_run / last_error / next_run for cron + queue
  workers. The Jobs log tab needs filterable status pills, retry /
  discard row actions, and a payload + error inspector.

### Settings
- **Audience:** operator configuring the install.
- **Goal:** flip a toggle, paste a credential, save.
- **Surface:** sticky vertical nav inside the page (or horizontal tabs
  for the dozen sub-sections), grouped form fields with help text,
  test-connection buttons where relevant (SMTP, S3, OAuth2 provider).
- **Don't:** scatter unrelated settings on the same screen.

### Superusers
- **Audience:** operator managing admin accounts.
- **Goal:** add or remove an admin.
- **Surface:** small list, drawer for create/edit. Keep it simple.

### API tokens
- **Audience:** developer issuing service tokens.
- **Goal:** create a token with a label, copy it once, see when it was
  last used.

---

## Specific things we know are weak today

If you redesign the entire system you can reshape these — listed so the
redesign explicitly addresses them, not buries them:

- **Density isn't consistent.** Some pages feel tight (Records),
  others too airy (Dashboard). Pick a density and apply it.
- **Empty states are perfunctory.** They say "No records yet" without
  explaining how to get the first one in. Redesign them as small
  onboarding moments.
- **The filter bar on Records is two UIs in one** — chips + raw
  expression. The mapping is unclear. Pick one primary, demote the
  other to a power-user toggle.
- **Settings is a long single page broken into PrimeReact accordion
  sections.** It's hard to find anything. Redesign as a left-rail nav
  with deep-linkable sub-pages.
- **Action affordances are weak.** Row hover sometimes reveals
  trash/edit icons, sometimes not. Standardize the row-action pattern.
- **The dashboard has stat cards but no signal.** A real operator
  wants "what's broken right now" first; pretty number-go-up tiles
  second.
- **The Setup wizard works but feels generic.** Lean on the brand —
  the vault metaphor, the "you own this data" idea — for first-run
  delight without slowing it down.
- **Modals and drawers have inconsistent footers.** Some have sticky
  Save/Cancel, some inline ones. Standardize.
- **Toasts are rare.** Background ops (save, delete, import) often
  fire silently or spam multiple toasts. Redesign the toast pattern
  with a proper queue and aggregation.

---

## What "done" looks like for the redesign

Deliverables we can implement against:

1. **A component sheet** — every atom and composite component on one
   page, in every relevant state (default, hover, focus, active,
   disabled, error, loading). Annotated with the exact tokens used
   (e.g., `bg: var(--bg-panel)`, `border: 1px var(--border-subtle)`).
2. **A page sheet per screen** — full-viewport mockup at 1440×900,
   showing populated, empty, and error states where they exist.
3. **A motion sheet** — three or four key transitions (modal enter,
   drawer slide, accordion expand, toast appear) with duration and
   easing. Static frames are fine; describe the in-between.
4. **A copy sheet for empty / loading / error states** — the actual
   words. Generic placeholder copy ("Lorem ipsum") in the mockups makes
   this hard to translate into the real product.

---

## Constraints we can flex on

- **Sidebar shape.** Today: 220px expanded only. A collapsed-icon mode
  is fine if you want one. A horizontal command-palette-driven nav (no
  sidebar at all) is also acceptable — argue for it if you propose it.
- **Topbar.** Today: page title left, actions right. Could become a
  page-header pattern under the topbar with the title bigger. Could
  collapse into the sidebar. Open question.
- **Tabs.** Today: 2px accent underline. Could become segmented
  control or sub-nav rail.
- **Code editor surface.** Today: full-screen modal. Could become a
  side drawer or a dedicated editor route. Pick what reads best.
- **Realtime indicators.** Today: nothing visible. Worth surfacing the
  active subscription count, recent broadcasts, etc.

---

## Audience and tone (recap)

We are designing for a developer who:

- Lives in their terminal and editor most of the day
- Already chose this product over Supabase / Firebase / PocketBase
- Will spend hours in the admin and gets frustrated by slow,
  airy, mouse-centric UIs
- Reads technical writing for a living and prefers a precise label
  over a friendly one

If a design choice would make sense in Linear, Vercel, Notion, GitHub,
or a JetBrains IDE, it's probably right for here. If it would make
sense in a marketing site or a kindergarten LMS, it isn't.

---

## What this is NOT

- A marketing landing page (we already have a brief for that)
- A docs site (we already have one)
- A re-skin — we want the underlying interaction to evolve too
- A platform-spanning system — desktop only, dark only, mouse +
  keyboard primary

---

## Pages and components — checklist

Use this as a coverage checklist:

### Shell
- [ ] Sidebar (full)
- [ ] Sidebar (collapsed, if proposed)
- [ ] Topbar (default)
- [ ] Topbar (with back button)
- [ ] Topbar (with breadcrumb)
- [ ] Page header pattern

### Atoms
- [ ] Buttons: primary / secondary / ghost / danger / icon — all states
- [ ] Inputs: text / mono / number / textarea — all states
- [ ] Select / Dropdown
- [ ] Chips input
- [ ] Toggle (on / off / disabled / focused)
- [ ] Radio + Checkbox
- [ ] Date / time picker
- [ ] Color picker (if needed for OAuth2 provider customization)
- [ ] Type chip (all 14)
- [ ] Status badge (success / warning / danger / info / neutral)
- [ ] Callout (4 tones)
- [ ] Code block (inline + multi-line)
- [ ] kbd shortcut visual
- [ ] Tooltip
- [ ] Spinner / progress bar
- [ ] Empty state
- [ ] Pagination (numeric + cursor)

### Composite
- [ ] Data table — sticky header, sortable, inline edit, bulk select,
      row actions, frozen first column
- [ ] Tab bar (already exists — refine)
- [ ] Segmented control
- [ ] Filter expression bar (chips → expression)
- [ ] Command palette (cmd+k)
- [ ] Modal (small / medium / maximized)
- [ ] Drawer (right, 480px)
- [ ] Dropdown menu
- [ ] Popover
- [ ] Toast / notification
- [ ] Side-panel inspector (record drawer, log drawer)
- [ ] Stat card with sparkline
- [ ] Code editor chrome (Monaco wrapper toolbar + status strip)
- [ ] Confirm dialog (small modal variant)

### Pages
- [ ] Setup wizard
- [ ] Login
- [ ] Dashboard
- [ ] Collections list
- [ ] Collection edit (schema editor — already done, align with it)
- [ ] Records list
- [ ] Record drawer / full edit
- [ ] API preview
- [ ] Logs
- [ ] Log inspector
- [ ] Hooks — Record hooks tab
- [ ] Hooks — Custom routes tab
- [ ] Hooks — Cron jobs tab
- [ ] Hooks — Workers tab
- [ ] Hooks — Jobs log tab + payload inspector
- [ ] Hooks — Monaco editor modal (full-screen)
- [ ] Settings — General
- [ ] Settings — Auth features
- [ ] Settings — OAuth2 providers
- [ ] Settings — SMTP
- [ ] Settings — File storage (local / S3 / R2)
- [ ] Settings — Rate limiting
- [ ] Settings — Encryption
- [ ] Settings — Backup / restore
- [ ] Settings — Migrations
- [ ] Superusers list + drawer
- [ ] API tokens list + create dialog
- [ ] 404 / route-not-found inside the admin

---

## Tone for visible copy in the mockups

When labeling buttons, empty states, and tooltips, write the way the
product itself writes:

- Direct. "Save changes" not "Save your changes!"
- Specific. "3 fields changed" not "Changes pending"
- Code-aware. `@request.auth.id != ""` shown verbatim, never paraphrased
- Honest. "Empty" not "It looks like you don't have any records yet 🙂"

---

## Repo facts (so the design doesn't drift)

- Logo: hexagonal vault mark (already shipped, SVG in
  `admin/src/components/VaultbaseLogo.tsx`)
- Wordmark: lowercase `vaultbase`, Inter 700, -0.01em tracking
- Versioning shown in the sidebar footer as `v0.1.x` mono
- Admin is rendered inside the binary at `/_/`, so the canonical
  "screen" is whatever the user sees at that URL — not a separate
  marketing site
