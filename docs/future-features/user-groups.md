# User Groups — design brainstorm

> Status: **brainstorm**. Not implemented. Review and decide before any code lands.

A think-out-loud on adding **user groups** (a.k.a. roles, teams, segments) to
Vaultbase. Goal: let admins assign many users to a named group, then reference
that group in API rules, hooks, file tokens, rate-limit audiences, and feature
flag targeting — without each subsystem inventing its own membership model.

---

## What we're building

A **group** is a named bucket of users from a single auth collection.
Memberships are many-to-many.

Three things land together:

1. **DB model** — `vaultbase_groups` + `vaultbase_group_memberships`.
2. **Eval surface** — `@request.auth.groups` available in the existing rule
   DSL (used by `view_rule`, `list_rule`, etc.). `helpers.userGroups(userId)`
   in hooks/routes/jobs.
3. **Admin UI** — a **Groups** page (or under each auth collection's
   detail). Per-group: name, description, member list, optional metadata.

A group is owned by exactly one auth collection. Cross-collection groups
are out of scope (and probably a smell — different auth collections imply
different security domains).

```
vaultbase_groups
  id           TEXT PRIMARY KEY
  collection_id TEXT NOT NULL  -- auth collection this group belongs to
  name         TEXT NOT NULL
  description  TEXT NOT NULL DEFAULT ''
  metadata     TEXT NOT NULL DEFAULT '{}'   -- JSON for extension
  created_at   INTEGER
  updated_at   INTEGER
  UNIQUE (collection_id, name)

vaultbase_group_memberships
  id            TEXT PRIMARY KEY
  group_id      TEXT NOT NULL REFERENCES vaultbase_groups(id) ON DELETE CASCADE
  user_id       TEXT NOT NULL    -- vaultbase_users.id
  added_at      INTEGER
  added_by      TEXT             -- admin user_id, optional
  UNIQUE (group_id, user_id)
```

---

## Use cases

### App-developer

- **RBAC primitive** — `admins`, `editors`, `viewers`, `billing-managers`.
  Each role is a group; rules read `"admins" in @request.auth.groups`.
- **Multi-tenant SaaS** — one group per organization. User in `org_acme`
  sees only their tenant's records via
  `tenant_id = @request.auth.groups[0]` (or a more sophisticated rule).
- **Beta access** — a `beta-testers` group. Combine with feature flags
  ("flag enabled when `beta-testers` in groups").
- **Plan tiers** — `free`, `pro`, `enterprise`. Hooks read the user's
  groups and gate behavior (rate limit, max records, features).
- **Workspace memberships** — a user belongs to multiple workspaces, each
  a group. Records carry a `workspace_id`; rule restricts to
  `workspace_id in @request.auth.groups`.

### Admin / ops

- **Bulk operations** — "send all `pro` users a feature announcement"
  via a hook + groups query.
- **Soft kill switch per cohort** — disable an endpoint for the
  `flagged-abuse` group with a rule.
- **Targeted rate limits** — per-rule audience extends from
  `all/guest/auth` to `group:<name>` (e.g. `group:partners` gets a
  higher budget).
- **Audit-friendly access removal** — drop a user from `admins`, no
  password rotation needed; their JWT keeps working but the
  group-based rules now deny.

---

## Where it lives

### JWT carries group membership

Add `groups: string[]` to the user JWT payload at mint time:

```json
{
  "id": "...", "email": "...", "aud": "user",
  "groups": ["admins", "editors"]
}
```

This means the rule engine can read `@request.auth.groups` without a DB
lookup per request. Trade-off: stale group state until token refresh.
Mitigation: short token windows (already configurable, see Session
lifetimes), or use the `/refresh` endpoint, or rotate JWT secret on
membership-policy changes.

For long-lived tokens, a `helpers.userGroups(userId)` lookup is available
when freshness matters. Lookup cached in-process for the request lifetime.

### Rule DSL extension

The existing rule parser has `@request.auth.id`, `@request.auth.email`,
`@request.auth.type`. Add `@request.auth.groups` (string array). Operators:

- `"admins" in @request.auth.groups` → bool
- `@request.auth.groups ~ "admin*"` → glob match against any element
- Length: `@request.auth.groups != []` (truthy if non-empty)

The DSL already supports arrays for `select` fields, so the parser hit
should be small.

### Hook helpers

```ts
helpers.userGroups(userId?: string): Promise<string[]>;
  // Returns the live group names for a user. Defaults to ctx.auth?.id.

helpers.requireGroup(name: string): Promise<void>;
  // Convenience: throws ValidationError("Unauthorized") if caller isn't
  // in the group. Useful at the top of a hook for quick gating.

helpers.addToGroup(userId, groupName): Promise<void>;
helpers.removeFromGroup(userId, groupName): Promise<void>;
  // Mutate membership programmatically (admin operations only — runtime
  // assertion).
```

### Custom routes

Same `helpers.*` API as hooks. A custom route gating a webhook by group:

```js
if (!ctx.auth?.groups?.includes("webhook-receivers")) {
  ctx.set.status = 403;
  return { error: "Forbidden" };
}
```

### Realtime broadcast

`shouldSendTo(ws, opts)` already evaluates `view_rule`. Group references in
that rule (`"editors" in @request.auth.groups`) just work — auth context
on the WS already has `groups` because we mint them with it.

### Rate limiting

Add a rule audience: `group:<name>`. Match if the auth context's groups
include `name`. Keeps per-rule budgets focused.

```
*:create   group:pro     1000   60000
*:create   group:free    20     60000
*:create   *             60     5000
```

### Feature flags (when/if shipped)

Targeting rule shape extends with `groups: string[]` — rule matches if
caller is in any of the listed groups. Reuses the same lookup path.

### File tokens

Per-user file tokens already evaluate `view_rule`. With groups, an admin
can write `view_rule = "owner = @request.auth.id || 'editors' in @request.auth.groups"` — done.

### Admin UI

**Groups** as a top-level item under each auth collection in the
sidebar (or a dedicated nav entry).

Per group page:
- Name / description (edit in place)
- Members list — paginated, with search
  - Add member: lookup user by email
  - Remove member: row action
  - Bulk add: paste a list of emails / ids
- Metadata editor (JSON; optional)
- "Used in" panel: which rules / flags / hooks / rate-limit rules
  reference this group? (Helps avoid orphaning rules when deleting.)
- Audit trail: when each member joined, by whom

Per user page (already exists in admin):
- New "Groups" tab showing memberships + add/remove inline

---

## Gain

1. **First-class authorization primitive**. Today every auth case has to
   roll its own — store role in `data` JSON, custom hooks to check, etc.
   Groups give one canonical place.
2. **Reuses every existing subsystem** — rules, hooks, rate-limit
   audiences, file tokens, future feature flags, future SDKs.
3. **JWT-embedded groups** = zero per-request DB cost for the common case.
4. **Clean RBAC story** — "is this user an admin of org X?" is one
   `in @request.auth.groups` check.
5. **Multi-tenant patterns become trivial** instead of bespoke.
6. **Admin UI provides the discoverability** — admins can see
   memberships, audit recent changes, find which rules use a group
   (the "Used in" panel).
7. **Composable with feature flags + Redis** — a future
   `users-in-group:<name>` channel for live invalidation.
8. **Bulk operations** — `helpers.queryGroupMembers(name)` enables
   announcements, mass updates, etc.

## Loss / cost

1. **JWT bloat** — 5+ groups balloon token size. Mitigation: cap at 32
   groups per user, document. Drop to lookup mode beyond that (no
   embedded `groups` claim).
2. **Stale memberships** in JWTs until refresh. Acceptable for most use
   cases; document. Critical decisions (admin removal) need secret
   rotation OR a future revocation list.
3. **Rule engine surface grows** — `@request.auth.groups` and `in`
   operator add parser/eval complexity. Test matrix increases.
4. **Database growth** — a 1M-user app with 5 groups each = 5M rows in
   memberships. Index on `(user_id, group_id)` essential. Bound at
   reasonable scale; document.
5. **Cascade behavior** — when a user is deleted, all their memberships
   should drop. Already ON DELETE CASCADE on `group_id`; need same for
   `user_id` (FK to `vaultbase_users`).
6. **Naming collisions** — global namespace per collection means two
   admins can race-create `admins` groups (one wins via UNIQUE; the
   other 422s). Fine.
7. **Migration story** — admin deletes a group referenced by 17 rules.
   Rules silently start failing every check that depended on that group
   ("admins" not found → membership returns false). Mitigation: "Used
   in" panel + soft-delete warning ("This group is referenced in N
   rules; deleting will affect their behavior").
8. **Test surface expands** — every rule-aware subsystem needs at least
   one group-aware test.

## Edge cases

- **Empty group** — valid; `@request.auth.groups = []`. Rules using
  `"x" in @request.auth.groups` correctly return false.
- **Group with thousands of members** — listing + pagination needs to
  handle. UI cap at 100 per page, link to bulk export.
- **User in N groups** — embed all in JWT up to a cap; lookup beyond.
- **Renaming a group** — internal id stable, name changes; rules
  reference name (string), so renaming silently breaks every rule.
  Mitigation: warn before save, optional "rewrite all rules" helper.
  Or: rules reference id (UUID) but admin UI shows name. Trade-off:
  human-readable rules vs rename-safe rules. Lean: name-based + warn,
  matches PB-style.
- **Deleting a group** — cascade memberships; rules referencing it
  evaluate to false (no error); flag a banner in Logs ("rule
  references missing group X").
- **Cross-collection groups** — out of scope. If you need shared
  membership, add a relation field to a "memberships" base collection
  and write the rule against that.
- **Admin assignment of groups during register / oauth** — hooks fire
  on `beforeCreate` / `afterCreate`. Admins write `helpers.addToGroup(...)`
  there. Document this idiom.
- **Anonymous + groups** — anonymous users have no groups by definition.
  Reject `addToGroup` for `is_anonymous=1` users with 422. Document.
- **Promotion + groups** — when an anonymous user is promoted, their
  group memberships (none) carry forward to the real account. Fine —
  it's a no-op.
- **Refresh token + group changes** — refresh re-mints with the
  *current* group list. Built-in refresh ratchet works in our favor.

---

## Why ship this

- Vaultbase has hooks, rules, rate limits, file tokens, OAuth, MFA,
  realtime — everything a real app needs **except** a way to put users
  in buckets. Today every operator has to bolt this on with hand-rolled
  hooks and a `role` field in `data`.
- Groups are the single missing piece for serious multi-tenant /
  RBAC apps. Adding them unblocks dozens of patterns.
- Implementation is small relative to impact: 1 helper, 1 DSL extension,
  1 admin page, no new architecture.

## Why not (yet)

- For 1-tenant apps where the only role distinction is admin vs user,
  groups are overkill. The existing `auth.type === "admin"` check
  already covers that case.
- Adding `@request.auth.groups` makes the rule DSL slightly less
  scrutable for new users.
- Membership state in DB raises the schema-change blast radius — admin
  deletes wrong group, several rules silently start denying.

---

## Rough size

| Piece | Effort |
|---|---|
| DB tables + migration + Drizzle schema | XS |
| `core/groups.ts` (CRUD, membership, lookup, helpers) | S |
| Rule DSL: `@request.auth.groups` + `in` operator | S |
| JWT mint: include `groups` claim (with cap + ALS lookup if over) | XS |
| Hook helpers (`userGroups`, `requireGroup`, `addToGroup`, `removeFromGroup`) | XS |
| Rate-limit audience extension (`group:<name>`) | XS |
| Admin: groups list page + per-group detail + "Used in" panel | M |
| Admin: per-user groups tab | S |
| Tests (DSL, JWT, helpers, rate limit, rule eval with groups, cascade) | M |
| Docs (concepts/authentication.md, concepts/rules.md, new concepts/groups.md) | S |

Estimate: **4–5 focused days** for v1.

---

## Open questions for review

1. **Name-based vs id-based references in rules.**
   Lean: name-based. Same pattern as field references in rules. Add a
   "rename impact" warning when changing.
2. **JWT cap on group count.** 32? 64? Most apps will have ≤10 groups
   per user. Cap to keep tokens small. Lean: 32; lookup mode beyond.
3. **Should anonymous users have groups?** Lean: no. Reject in
   addToGroup. Anonymous → real promotion is when groups become possible.
4. **Should the admin pseudo-group `admins` exist by default?** No.
   Admins are out-of-band (`vaultbase_admin` table, JWT aud=admin).
   Groups are a property of *user* tokens. Document this distinction.
5. **Group metadata** (the `metadata` JSON column) — useful but easy
   to misuse as a key-value store. Document it as
   "ephemeral display config; don't put auth-critical state here."
6. **API endpoints.** `GET /api/admin/groups`, `POST/PATCH/DELETE
   /api/admin/groups[/:id]`, `POST/DELETE /api/admin/groups/:id/members`.
   Mirror the existing collections / hooks / routes / jobs pattern.
7. **Self-service groups** — should users be able to create / join their
   own groups (think Discord servers)? Out of scope for v1; admin-only.
   Future expansion.
8. **Group attributes for rule evaluation.** Could rules evaluate
   `@request.auth.groups[0].metadata.tier`? Pushes toward groups-as-objects.
   Defer; v1 keeps groups as simple string-name lists. A
   `helpers.groupMetadata(name)` lookup covers the rare case.
9. **Should there be a "default group on register"?** Some apps want
   every new user automatically in `members`. Achievable today via
   `afterCreate` hook calling `helpers.addToGroup`. Don't add a built-in.
10. **Realtime broadcast on membership change?** Probably yes —
    `{ type: "group-update", group, userId, action: "added"|"removed" }`
    on the user's own private channel. Useful for "your role just changed,
    re-render."

---

## What this would NOT do

- **Not** an org / workspace data model. Groups are tag-style. If you
  need first-class workspaces with their own collections + records, build
  that with a regular `workspaces` collection + a relation field to
  users.
- **Not** a full RBAC matrix. Permissions still live in collection rules.
  Groups are *inputs* to those rules, not a separate permissions table.
- **Not** hierarchical (no nested groups in v1). `admins ⊃ editors ⊃
  viewers` is a future addition.
- **Not** per-record. Groups attach to users, not records. To gate
  records by group, the rule does the heavy lifting (`record.tenant_id =
  @request.auth.groups[0]`).
- **Not** a permission language extension. The existing rule DSL is
  enough; we just add a new field reference + operator.

---

## Recommendation

Ship after **JS SDK** (so SDK natively exposes `vb.user.groups` +
`onGroupChange()`) and probably alongside or just after **feature flags**
(since the targeting story leverages groups). Phased:

1. **Phase 1** (1 day): DB + core CRUD + JWT claim + DSL + hook helpers.
   No UI yet; admins manage via API.
2. **Phase 2** (1.5 days): Admin UI — list + per-group detail + member
   management.
3. **Phase 3** (1 day): "Used in" panel + per-user groups tab + audit.
4. **Phase 4** (0.5 day): Rate-limit audience extension, realtime
   group-change broadcast, docs.
5. **Phase 5 (later)**: hierarchical groups, group attributes in rules.

Total Phase 1–4: ~4 days.

If we never want to ship this, the workaround is documented: store
roles/groups in `user.data.roles[]` and write rules against that JSON
field. Ugly but works. Groups make this canonical, type-checked, and
admin-discoverable.
