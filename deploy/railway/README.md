# Railway template

Railway templates are made in Railway's dashboard, so this is the recipe for
creating (or re-creating) the Vaultbase template. Once published, its
"Deploy on Railway" button link goes on the landing and in the docs.

1. railway.com → **New Project** → **Empty project**, then **+ Create** →
   **Docker Image**: `ghcr.io/vaultbase-sh/vaultbase:latest`.
2. On the service, **Settings**:
   - **Networking** → **Generate Domain**, target port `8091`.
   - **Healthcheck path**: `/_/ready`.
   - **Volume** (right-click the service → **Attach volume**), mount path `/data`.
3. **Variables** (the `${{secret(…)}}` ones generate a value per deployment):

   | Variable | Value |
   |---|---|
   | `VAULTBASE_PORT` | `8091` |
   | `VAULTBASE_JWT_SECRET` | `${{secret(43)}}` |
   | `VAULTBASE_ENCRYPTION_KEY` | `${{secret(32)}}` (exactly 32 characters: the key must decode to 32 bytes) |
   | `VAULTBASE_SETUP_KEY` | `${{secret(32)}}` |
   | `VAULTBASE_TRUSTED_PROXIES` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7` |
   | `VAULTBASE_READ_WORKERS` | `0` |

4. Deploy, check `https://<domain>/_/ready` answers `ready`, then open
   `/_/setup` with the setup key from the Variables tab.
5. Project **Settings** → **Generate Template** (or **Templates** → **Create**),
   name it *Vaultbase*, description "Self-hosted backend in a single binary:
   collections, REST, auth, realtime, files, hooks.", publish it, and copy the
   button link (`https://railway.com/deploy/<code>`).

Keep the service at one replica: SQLite lives on the volume.
