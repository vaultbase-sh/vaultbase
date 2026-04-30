#!/bin/sh
# Vaultbase one-shot installer.
#
# Downloads the appropriate prebuilt binary from GitHub releases, installs it
# to /usr/local/bin, creates the `vaultbase` system user + data dir, drops a
# hardened systemd unit, and starts the service.
#
# Usage:
#
#   curl -fsSL https://get.vaultbase.dev | sh
#
#   # Pin a specific version
#   curl -fsSL https://get.vaultbase.dev | sh -s -- --version v0.1.8
#
#   # Override the listen port
#   curl -fsSL https://get.vaultbase.dev | sh -s -- --port 9000
#
#   # Install but do not start (useful when running behind a reverse proxy
#   # you want to configure first)
#   curl -fsSL https://get.vaultbase.dev | sh -s -- --no-start
#
#   # Verify cosign keyless signature before installing (requires `cosign`
#   # on PATH — install from https://docs.sigstore.dev/cosign/installation/).
#   # Confirms the binary was built and signed by the project's GitHub
#   # Actions runner via the Sigstore Fulcio chain.
#   curl -fsSL https://get.vaultbase.dev | sh -s -- --verify-sig
#
# Re-running the script upgrades the binary in place. Existing data dir,
# JWT secret, and admin accounts are preserved.
#
# Exit codes:
#   0   success
#   1   user-fixable error (unsupported platform, network, missing tools)
#   2   internal error (download verification failed, write permission)

set -eu

# ── Defaults ────────────────────────────────────────────────────────────────
REPO="vaultbase-sh/vaultbase"
RELEASES_URL="https://github.com/${REPO}/releases"
INSTALL_DIR="/usr/local/bin"
DATA_DIR="/var/lib/vaultbase"
ETC_DIR="/etc/vaultbase"
ENV_FILE="${ETC_DIR}/vaultbase.env"
UNIT_FILE="/etc/systemd/system/vaultbase.service"
SVC_USER="vaultbase"
SVC_GROUP="vaultbase"
DEFAULT_PORT="8091"

VERSION=""
PORT="${DEFAULT_PORT}"
NO_START=0
NO_SYSTEMD=0
VERIFY_SIG=0

# ── Output helpers ──────────────────────────────────────────────────────────
say()    { printf '%s\n' "$*"; }
warn()   { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
err()    { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
ok()     { printf '\033[32m✓ %s\033[0m\n' "$*"; }
header() { printf '\n\033[1m── %s ──────────────────────────────────────────\033[0m\n' "$*"; }

die()    { err "$*"; exit 1; }

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --version)    VERSION="${2:-}"; shift 2 || die "--version needs a value" ;;
        --version=*)  VERSION="${1#*=}"; shift ;;
        --port)       PORT="${2:-}"; shift 2 || die "--port needs a value" ;;
        --port=*)     PORT="${1#*=}"; shift ;;
        --no-start)   NO_START=1; shift ;;
        --no-systemd) NO_SYSTEMD=1; shift ;;
        --verify-sig) VERIFY_SIG=1; shift ;;
        --help|-h)
            sed -n '3,30p' "$0" 2>/dev/null || true
            exit 0 ;;
        *)            die "Unknown flag: $1" ;;
    esac
done

# ── Pre-flight ──────────────────────────────────────────────────────────────
header "Pre-flight"

if [ "$(id -u)" -ne 0 ]; then
    die "This installer must run as root. Re-run with sudo."
fi

# OS check — Linux only for now. macOS uses launchd, not systemd; document
# manual install separately.
case "$(uname -s)" in
    Linux) ok "OS: Linux" ;;
    *)     die "Unsupported OS: $(uname -s). Linux only for now." ;;
esac

# Arch detection.
ARCH=""
case "$(uname -m)" in
    x86_64|amd64)   ARCH="linux-x64" ;;
    aarch64|arm64)  ARCH="linux-arm64" ;;
    *)              die "Unsupported architecture: $(uname -m). Supported: x86_64, aarch64." ;;
esac

# Detect Alpine / musl — Bun ships separate musl binaries.
if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    if [ "${ARCH}" = "linux-x64" ]; then
        ARCH="linux-x64-musl"
        ok "Detected musl libc — using ${ARCH} build"
    fi
fi
ok "Architecture: ${ARCH}"

for cmd in curl install id useradd; do
    command -v "${cmd}" >/dev/null 2>&1 || die "Missing required tool: ${cmd}"
done

# Detect whether systemd is the init system. Containers often run without it.
if [ "${NO_SYSTEMD}" -eq 0 ]; then
    if [ ! -d /run/systemd/system ]; then
        warn "systemd not detected (no /run/systemd/system). Skipping unit install."
        warn "You will need to run vaultbase under your own supervisor (runit, s6, supervisord, ...)."
        NO_SYSTEMD=1
    fi
fi

# ── Resolve version ─────────────────────────────────────────────────────────
header "Resolve release"

if [ -z "${VERSION}" ]; then
    # Capture the redirect target without following — `/releases/latest` 302s
    # to `/releases/tag/<vX.Y.Z>`. We must NOT pass `-L` here or curl follows
    # the redirect and `%{redirect_url}` ends up empty.
    VERSION="$(curl -fsS -o /dev/null -w '%{redirect_url}' "${RELEASES_URL}/latest" \
        | sed 's|.*/tag/||')"
    [ -n "${VERSION}" ] || die "Could not resolve latest release tag from GitHub. Check ${RELEASES_URL} — does this repo have any published releases yet?"
    ok "Latest release: ${VERSION}"
else
    case "${VERSION}" in
        v*) : ;;
        *)  VERSION="v${VERSION}" ;;
    esac
    ok "Pinned release: ${VERSION}"
fi

# Asset name pattern matches package.json's build script outputs.
ASSET="vaultbase-${ARCH}"
URL="${RELEASES_URL}/download/${VERSION}/${ASSET}"
SHA_URL="${URL}.sha256"
SIG_URL="${URL}.sig"
CERT_URL="${URL}.pem"

# ── Download + verify ───────────────────────────────────────────────────────
header "Download"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT INT TERM

say "Fetching ${URL}..."
curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/vaultbase" "${URL}" \
    || die "Download failed. Check ${RELEASES_URL} for available assets and the network from this host."

# Optional sha256 verification — works when the release ships a `.sha256`
# alongside the binary (recommended, but tolerate absence so installs don't
# break for older releases).
if curl -fsSL --retry 2 -o "${TMP}/vaultbase.sha256" "${SHA_URL}" 2>/dev/null; then
    EXPECTED="$(awk '{print $1}' "${TMP}/vaultbase.sha256")"
    if command -v sha256sum >/dev/null 2>&1; then
        ACTUAL="$(sha256sum "${TMP}/vaultbase" | awk '{print $1}')"
    else
        ACTUAL="$(shasum -a 256 "${TMP}/vaultbase" | awk '{print $1}')"
    fi
    [ "${EXPECTED}" = "${ACTUAL}" ] \
        || { err "SHA-256 mismatch. expected=${EXPECTED} actual=${ACTUAL}"; exit 2; }
    ok "SHA-256 verified"
else
    warn "No .sha256 published for this release — skipping integrity check."
fi

# Optional cosign keyless signature verification (--verify-sig). Confirms the
# binary was built and signed by the project's GitHub Actions runner via the
# Sigstore Fulcio chain. Requires `cosign` on PATH.
if [ "${VERIFY_SIG}" -eq 1 ]; then
    if ! command -v cosign >/dev/null 2>&1; then
        die "--verify-sig requested but \`cosign\` is not on PATH. Install: https://docs.sigstore.dev/cosign/installation/"
    fi
    say "Fetching cosign signature + certificate..."
    curl -fsSL --retry 3 -o "${TMP}/vaultbase.sig"  "${SIG_URL}"  || die "Could not fetch ${SIG_URL}"
    curl -fsSL --retry 3 -o "${TMP}/vaultbase.pem"  "${CERT_URL}" || die "Could not fetch ${CERT_URL}"
    cosign verify-blob \
        --certificate "${TMP}/vaultbase.pem" \
        --signature "${TMP}/vaultbase.sig" \
        --certificate-identity-regexp "^https://github\\.com/${REPO}/" \
        --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
        "${TMP}/vaultbase" \
        || { err "Cosign verification failed."; exit 2; }
    ok "Cosign signature verified — binary built by ${REPO} GitHub Actions"
fi

chmod 0755 "${TMP}/vaultbase"

# ── User + dirs ─────────────────────────────────────────────────────────────
header "Service user + directories"

if id -u "${SVC_USER}" >/dev/null 2>&1; then
    ok "User '${SVC_USER}' already exists"
else
    useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "${SVC_USER}"
    ok "Created system user '${SVC_USER}'"
fi

install -d -m 0750 -o "${SVC_USER}" -g "${SVC_GROUP}" "${DATA_DIR}"
install -d -m 0755 -o root         -g root           "${ETC_DIR}"
ok "Data dir: ${DATA_DIR}"
ok "Config dir: ${ETC_DIR}"

# ── Env file (preserve existing JWT secret) ────────────────────────────────
if [ -f "${ENV_FILE}" ]; then
    ok "Existing ${ENV_FILE} — keeping JWT secret + values"
else
    JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
    umask 077
    cat > "${ENV_FILE}" <<EOF
# Vaultbase configuration — generated by the installer on $(date -u +%FT%TZ)
# Override any of these and run \`systemctl restart vaultbase\` to apply.

VAULTBASE_PORT=${PORT}
VAULTBASE_DATA_DIR=${DATA_DIR}

# Persisted JWT signing key. Loss = every issued token is invalidated.
# Rotate by changing this value and forcing all clients to reauthenticate.
VAULTBASE_JWT_SECRET=${JWT_SECRET}

# Optional: required only if you use encrypted fields.
# Generate with: head -c 32 /dev/urandom | base64
# VAULTBASE_ENCRYPTION_KEY=

# Optional: comma-separated list of allowed origins for CORS / WS upgrades.
# VAULTBASE_ALLOWED_ORIGINS=https://your-app.example.com
EOF
    chown root:"${SVC_GROUP}" "${ENV_FILE}"
    chmod 0640 "${ENV_FILE}"
    umask 022
    ok "Wrote ${ENV_FILE} (mode 0640) with fresh JWT secret"
fi

# ── Install binary (atomic) ─────────────────────────────────────────────────
header "Install binary"

install -m 0755 -o root -g root "${TMP}/vaultbase" "${INSTALL_DIR}/vaultbase.new"
mv -f "${INSTALL_DIR}/vaultbase.new" "${INSTALL_DIR}/vaultbase"
ok "Installed ${INSTALL_DIR}/vaultbase"

# ── systemd unit ────────────────────────────────────────────────────────────
if [ "${NO_SYSTEMD}" -eq 0 ]; then
    header "systemd unit"

    cat > "${UNIT_FILE}" <<'UNIT'
[Unit]
Description=Vaultbase backend
Documentation=https://docs.vaultbase.dev
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vaultbase
Group=vaultbase
EnvironmentFile=/etc/vaultbase/vaultbase.env
ExecStart=/usr/local/bin/vaultbase
Restart=on-failure
RestartSec=2s
TimeoutStopSec=30s
LimitNOFILE=65536

# Hardening — vaultbase needs nothing from the host filesystem outside
# its data dir. Lock everything else down.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
LockPersonality=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
MemoryDenyWriteExecute=no
# `SystemCallFilter` was removed: Bun uses syscalls outside the
# `@system-service` set (notably some io_uring + mmap variants), which
# triggers SIGSYS and a core dump under seccomp. The hardening above is
# enough to neutralise the typical privilege-escalation paths.

# Vaultbase only needs to write inside its data dir. ProtectSystem=strict
# makes /etc/vaultbase read-only from the service's view (config is read once).
ReadWritePaths=/var/lib/vaultbase
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
UNIT
    chmod 0644 "${UNIT_FILE}"
    ok "Wrote ${UNIT_FILE}"

    systemctl daemon-reload

    if [ "${NO_START}" -eq 0 ]; then
        systemctl enable --now vaultbase
        sleep 1
        if systemctl is-active --quiet vaultbase; then
            ok "vaultbase service is active"
        else
            warn "vaultbase failed to start. Inspect logs: journalctl -u vaultbase -n 50"
        fi
    else
        systemctl enable vaultbase
        ok "Service enabled (use 'systemctl start vaultbase' when ready)"
    fi
fi

# ── Done ────────────────────────────────────────────────────────────────────
header "Done"

cat <<EOF

  Vaultbase ${VERSION} installed.

    Binary:    ${INSTALL_DIR}/vaultbase
    Data dir:  ${DATA_DIR}
    Config:    ${ENV_FILE}
EOF

if [ "${NO_SYSTEMD}" -eq 0 ]; then
    cat <<EOF
    Service:   systemctl {start|stop|restart|status} vaultbase
    Logs:      journalctl -u vaultbase -f

EOF
fi

cat <<EOF
  Next steps:

    1. Bootstrap an admin account (one-shot CLI, never exposes the web setup):
         sudo vaultbase setup-admin --email you@example.com --password '<pw>'

    2. Put a reverse proxy in front. Sample configs:
         https://docs.vaultbase.dev/getting-started/installation/

    3. Health check:
         curl http://127.0.0.1:${PORT}/api/health

  Re-run this script any time to upgrade the binary in place. Your data,
  config, and admin accounts are preserved.

EOF
