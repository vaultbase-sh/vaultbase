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
FROM debian:bookworm-slim

ARG TARGETARCH
# ca-certificates: outbound TLS from hooks (helpers.fetch), SMTP, OAuth, S3.
# curl: the health check. tini: signals and zombie reaping as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 vaultbase \
 && useradd --system --uid 10001 --gid vaultbase --home-dir /data --shell /usr/sbin/nologin vaultbase \
 && mkdir -p /data && chown vaultbase:vaultbase /data

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
