# The Vaultbase image: the signed release binary on Debian slim.
#
# Built by .github/workflows/docker.yml from a release's binaries, which it
# downloads and checks against that release's SHA256SUMS first, so the image
# runs exactly the published code:
#   deploy/docker/bin/vaultbase-linux-amd64, deploy/docker/bin/vaultbase-linux-arm64
#   docker buildx build --platform linux/amd64,linux/arm64 -f deploy/docker/Dockerfile deploy/docker
#
# Data lives in /data (mount a volume there). The entrypoint gives /data to
# the unprivileged `vaultbase` user when the host mounts it as root (Railway,
# Fly and Render do), then runs the server as that user.

# pg_dump, pg_restore and psql, for backups and restore on Postgres, from the
# PostgreSQL project's apt repository: Debian's own client (15) can't dump a
# newer server, and restore needs a client from August 2025 or later. The
# newest major dumps and restores every server version Vaultbase supports.
# Built here and copied over with the libpq they were built against: the
# package itself brings Perl (for Debian's version wrapper), about 50 MB the
# image doesn't need. The repository's key is checked by its fingerprint.
ARG PG_CLIENT_MAJOR=18
ARG PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8

FROM debian:bookworm-slim AS pgclient
ARG PG_CLIENT_MAJOR
ARG PGDG_KEY_FINGERPRINT
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && key=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && install -d "$(dirname "$key")" \
 && curl -fsSL -o "$key" https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && gpg --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10 }' | grep -qx "$PGDG_KEY_FINGERPRINT" \
 && echo "deb [signed-by=$key] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_CLIENT_MAJOR} \
 && mkdir -p /out/bin /out/lib \
 && cp /usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/pg_dump /usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/pg_restore /usr/lib/postgresql/${PG_CLIENT_MAJOR}/bin/psql /out/bin/ \
 && cp -P $(dpkg -L libpq5 | grep '/libpq\.so\.5') /out/lib/

FROM debian:bookworm-slim

ARG TARGETARCH
# ca-certificates: outbound TLS from hooks (helpers.fetch), SMTP, OAuth, S3.
# curl: the health check. tini: signals and zombie reaping as PID 1.
# libreadline8: what the PostgreSQL client tools link beyond those and libpq.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini libreadline8 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 vaultbase \
 && useradd --system --uid 10001 --gid vaultbase --home-dir /data --shell /usr/sbin/nologin vaultbase \
 && mkdir -p /data && chown vaultbase:vaultbase /data

COPY --from=pgclient /out/bin/ /usr/local/bin/
COPY --from=pgclient /out/lib/ /usr/local/lib/
RUN ldconfig
COPY --chmod=0755 bin/vaultbase-linux-${TARGETARCH} /usr/local/bin/vaultbase
COPY --chmod=0755 entrypoint.sh /usr/local/bin/vaultbase-entrypoint

ENV VAULTBASE_DATA_DIR=/data \
    VAULTBASE_PORT=8091
EXPOSE 8091
VOLUME ["/data"]

# Liveness: the process answers. Readiness (database, storage, queues) is
# /_/ready, which hosts with a readiness probe should use instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${VAULTBASE_PORT}/_/health" > /dev/null || exit 1

ENTRYPOINT ["tini", "--", "vaultbase-entrypoint"]
CMD ["vaultbase"]
