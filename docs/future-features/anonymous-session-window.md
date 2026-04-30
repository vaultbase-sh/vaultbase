# Anonymous session window — design brainstorm

> Status: **brainstorm**. Implemented.

A short brainstorm on making the anonymous-auth JWT lifetime configurable.
Today it's hardcoded to **30 days**; this proposal makes it tunable per
deployment, default unchanged.

---

## What we're building

`POST /api/auth/:collection/anonymous` issues a JWT with a fixed
`exp = now + 30d`. Move that 30d into a setting:

```
auth.anonymous.window_seconds = 2592000   # 30d (default)
```

Read at mint time, falls back to 30d when unset / invalid. Settable from
admin Settings → Auth features (or a new sub-section). Honors the existing
settings cache + invalidation pattern.

Optionally extend the same pattern to non-anonymous tokens too:

```
auth.user.window_seconds      = 604800    # 7d  (current default)
auth.admin.window_seconds     = 604800    # 7d  (current default)
auth.refresh.window_seconds   = 604800    # 7d
auth.otp.window_seconds       = 600       # 10m
auth.verify.window_seconds    = 3600      # 1h
auth.reset.window_seconds     = 3600      # 1h
auth.mfa.window_seconds       = 300       # 5m  (mfa_token between login+verify)
auth.merge.window_seconds     = 900       # 15m (oauth2_merge token)
auth.file.window_seconds      = 3600      # 1h  (protected-file token)
```

Each one is independent. Anonymous is the headline; the rest stack
naturally on the same machinery.

---

## Use cases

### Anonymous specifically

- **High-friction app, low-stakes data** — quiz / poll / one-shot survey.
  30d is way too long; cut to 24h to recycle ids.
- **Analytics-heavy app** — fingerprint a guest browser for 90d to track
  journey across visits. 30d truncates the window.
- **Multi-tenant SaaS demo mode** — give a tenant a "preview" identity
  for the length of the demo session (1h). Today no way without forking
  the auth code.
- **Compliance** — GDPR-aware operators want short-lived guest sessions
  to minimize PII retention. Today they have to hack JWT expiry
  client-side.

### General auth windows

- **Short-lived admin tokens** (e.g. 1h) for shared workstation security.
- **Long-lived user tokens** (90d) for mobile apps where re-auth is
  costly.
- **Tighter password-reset windows** (10m) for sensitive deployments.
- **Looser file-token windows** (24h) for media-heavy apps where
  signed-URL refresh is annoying.

---

## Where it lives

### Settings keys

Per the list above. Each subsystem reads via `getSetting("auth.X.window_seconds", "<default>")` at sign time. No DB changes; it's all in
`vaultbase_settings`. Cache invalidation already wired (PATCH busts the
settings cache, so the next mint reads fresh).

### Validation

- Must parse to an integer ≥ 60 (one minute floor — anything shorter is
  almost always a mistake; reject with 422 in the settings PATCH path).
- Soft cap: 365d (31_536_000). Higher values accepted but flagged in the
  admin UI ("This is unusually long; tokens this old can't be revoked
  without rotating the JWT secret.").
- Anonymous specifically: hard cap probably 90d. Anonymous + 1y JWT is a
  privacy footgun.

### Mint sites

- `src/api/auth.ts` `POST /api/auth/:collection/anonymous` — read
  `auth.anonymous.window_seconds`.
- Same file's other endpoints — read their respective keys.
- `src/api/auth.ts` impersonation — `auth.impersonate.window_seconds`,
  default 1h.

Centralize in one helper:

```ts
import { getSetting } from "./settings.ts";

export function tokenWindowSeconds(kind: TokenKind, fallback: number): number {
  const raw = getSetting(`auth.${kind}.window_seconds`, String(fallback));
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60) return fallback;
  return Math.min(n, 365 * 24 * 3600);
}
```

Every mint site picks its kind + sane default. No hardcoded numbers.

### Admin UI

In Settings → Auth features, expand the section:

- **Anonymous session window** — duration picker (1h / 1d / 7d / 30d / 90d
  / custom). Default 30d.
- **User session window** — same.
- **Admin session window** — same. Cap at 30d (admin sessions shouldn't
  outlive a quarterly review).
- **OTP / verify / reset / MFA / merge / file** — collapsed advanced
  section since these are short by design.

Each control writes the matching settings key. "Test current value" link
shows the resolved seconds + decoded human form.

---

## Gain

1. **Operator control** without forking code — currently the only way to
   change 30d is to recompile.
2. **Compliance posture** — easy to demonstrate "guest data lives at most
   N days" for audits.
3. **Per-deployment tuning** — pre-prod has 1h tokens, prod has 30d.
4. **Better UX in some apps** — long-lived guest sessions for journey
   tracking; short ones for transient flows.
5. **Touches one helper** — change is small, mostly mechanical.
6. **Stack with refresh** — refresh tokens already exist; tuning the
   anonymous window makes the refresh story coherent.

## Loss / cost

1. **Foot-gun potential** — operator sets 10y window, leaks token, no
   way to revoke without rotating the JWT secret (which logs everyone
   out). Mitigation: hard caps + warning copy in the UI.
2. **Test matrix grows** — token-expiry tests need to stub the helper
   instead of asserting `30 * 24 * 3600`.
3. **Settings PATCH timing** — operator changes window mid-session;
   already-issued tokens keep their old expiry. UI should make this
   clear ("Existing tokens are unaffected; new issues only.").
4. **Anonymous IDs accumulate** — long anonymous windows + active users =
   bloat in `vaultbase_users`. Mitigation: a separate "anonymous user
   reaper" job (any user with `is_anonymous=1` + `last_seen < now -
window` gets deleted). Out of scope for this brainstorm.
5. **Cluster sync** — same as every other settings key; existing
   invalidation handles it (or, post-Redis, the pub/sub channel does).

## Edge cases

- **Negative or zero value** — reject in settings PATCH validator.
  Mint always uses fallback if value missing/invalid.
- **Refresh interaction** — `POST /api/auth/refresh` re-mints with the
  _current_ window. So a session "ratchets forward" by the configured
  amount each refresh. This is fine and matches typical OAuth refresh
  semantics, but make it explicit in the docs.
- **Window shrunk while sessions are active** — old tokens keep their
  old expiry. Some operators expect "shrink the window = boot everyone."
  Document explicitly. If you want to boot them, rotate the JWT secret
  (existing `.secret` regen flow).
- **Window grown — fine** — already-issued tokens unaffected (they
  expire at their original time). Future mints get the new window.
- **Sliding vs fixed window** — JWTs are fixed-window by nature.
  "Sliding" requires either short windows + frequent refresh, or stateful
  sessions in DB. Out of scope for this proposal; keep it fixed.
- **Anonymous vs non-anonymous parity** — should anonymous always be
  ≥ user window? Probably yes (anonymous → real promotion would be weird
  if anon expires sooner than user). Add a soft constraint in the UI:
  warn if anonymous &lt; user.
- **Per-collection windows** (auth-collection-specific values) — defer.
  Per-deployment is enough. Per-collection is a future expansion.

---

## Why ship this

It's small. The 30d default is fine for most, but a few categories of
deployment really do need different windows (compliance, demo mode,
analytics). Today the answer is "fork the binary or implement custom
auth." Adding 1 settings key + 1 helper makes Vaultbase friendlier to
those use cases.

It also unifies the dozen-ish hardcoded `setExpirationTime("Xd")` /
`setExpirationTime("Xm")` calls scattered across `src/api/auth.ts` into
one helper, which is a refactor win even if no operator ever changes
the values.

## Why not (yet)

- 30d is fine for 90% of deployments.
- More UI surface in Settings is more complexity for users who don't
  need it.
- Audit-trail / token-revocation lists (the Redis brainstorm) are a
  better story for "I want to mitigate leaked long-lived tokens."
  Tuning the window is a weak alternative to revocation.

---

## Rough size

| Piece                                                                   | Effort |
| ----------------------------------------------------------------------- | ------ |
| `tokenWindowSeconds(kind, fallback)` helper + tests                     | XS     |
| Refactor every `setExpirationTime(...)` call to use it                  | S      |
| Settings UI section (anonymous + advanced collapsed)                    | S      |
| Validation in settings PATCH (min 60s, max 365d, hard cap on anonymous) | XS     |
| Docs page + roadmap                                                     | XS     |

Estimate: **half a day** end-to-end. Ship as a quick win.

---

## Open questions for review

1. **Just anonymous, or all token kinds at once?** Headline is anonymous,
   but the helper is the same for all of them. Doing all at once is
   cheaper than a follow-up.
2. **Hard cap on anonymous window?** 90d? 1y? Privacy posture decision.
   Lean: **365d hard cap, soft warn at 90d.**
3. **Soft constraint that anonymous ≤ user window?** Lean: yes, warn but
   don't block.
4. **Should the cap on admin window be lower than the user cap?** Yes —
   admin sessions should be short by default. Lean: admin hard cap 30d.
5. **Where does the UI live?** Add to existing **Settings → Auth
   features** vs a new **Settings → Sessions** tab. Lean: existing tab,
   collapsed advanced section for non-anonymous.
6. **Surface in the JS SDK?** `vb.config.tokenLifetimes` returned from a
   bootstrap endpoint so clients know when to refresh proactively.
   Probably yes, low cost.
7. **Anonymous reaper job** — cron that deletes expired anonymous users.
   Out of scope here, but flag for follow-up.
8. **Document explicitly that JWTs are fixed-window** — a 30d session
   doesn't extend on activity unless the client calls `/refresh`.
   Some users will assume "sliding" semantics.

---

## What this would NOT do

- **Not** introduce sliding-window sessions. JWTs stay stateless +
  fixed-expiry.
- **Not** invalidate already-issued tokens when the window changes.
- **Not** add token revocation. That's the Redis brainstorm.
- **Not** add per-user / per-collection / per-IP overrides. Per-deployment
  knob only in v1.
- **Not** delete anonymous users automatically. That's a separate cron
  / job.

---

## Recommendation

Ship as a **same-day quick win**, batched with the rest of the auth-
window unification:

1. Add `tokenWindowSeconds(kind, fallback)` helper in `src/core/auth-tokens.ts`
   (new tiny file).
2. Replace every `setExpirationTime("...")` in `src/api/auth.ts` with
   `setExpirationTime(tokenWindowSeconds(kind, defaultSec))`.
3. Validation in `src/api/settings.ts` PATCH for `auth.*.window_seconds`
   keys (min 60s, max 365d, anonymous hard cap = 90d if you go strict).
4. Admin UI section in Settings → Auth features.
5. 4-5 tests (helper falls back, settings PATCH rejects garbage, mint
   honors new value, refresh re-mints with current value).
6. Docs page (`concepts/authentication.md` gets a new "Session lifetimes"
   section).

Estimated total: ~half a day. Defer if Redis / SDK / flags work is
already in flight.
