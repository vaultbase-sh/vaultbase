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
