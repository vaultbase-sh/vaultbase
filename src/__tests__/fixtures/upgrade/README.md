# Upgrade-path fixtures

Each `vX.Y.Z.db` is the `data.db` of that real release, filled through its own API by
`scripts/make-upgrade-fixture.ts`; `vX.Y.Z.json` lists what was created (ids, values, which
steps the release supported). `upgrade-path.test.ts` opens every one with the current code
and checks the data, sign-ins, rules, a setting, a hook and the newest tables.

The admin and user passwords and the JWT secret in the manifests exist only for these
fixtures.

To add a release (do it for every release that changes the schema):

```sh
curl -fsSL -o /tmp/vb https://github.com/vaultbase-sh/vaultbase/releases/download/vX.Y.Z/vaultbase-macos-arm64
chmod +x /tmp/vb   # check it against that release's SHA256SUMS first
bun scripts/make-upgrade-fixture.ts vX.Y.Z /tmp/vb
```

## Postgres

`../upgrade-postgres/vX.Y.Z.sql` is the same, made on Postgres (releases from 0.23.0): a
plain `pg_dump` of the release's schema (`vbfixture`), with INSERTs and no owners or
grants, so Postgres 16 and later restore it. `upgrade-path-postgres.test.ts` restores
each into a fresh schema and makes the same checks. To add one, with an empty Postgres
the script may create and drop the `vbfixture` schema in, and `pg_dump` 16 on the PATH
(or named by `PG_DUMP`):

```sh
bun scripts/make-upgrade-fixture.ts vX.Y.Z /tmp/vb --postgres postgres://user:password@host:5432/db
```
