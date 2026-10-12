#!/bin/sh
# Vaultbase one-shot installer for Linux and macOS.
#
# Detects the OS, CPU architecture and libc, then downloads the matching
# prebuilt binary from GitHub releases and installs it to /usr/local/bin.
#
#   Linux:   also creates the `vaultbase` system user + data dir, drops a
#            hardened systemd unit, and starts the service.
#   macOS:   installs the binary only; run `vaultbase` yourself.
#   Windows: use the PowerShell installer instead:
#            irm https://get.vaultbase.dev/install.ps1 | iex
#
# Usage:
#
#   curl -fsSL https://get.vaultbase.dev | sudo sh
#
#   # Pin a specific version
#   curl -fsSL https://get.vaultbase.dev | sudo sh -s -- --version v0.1.8
#
#   # Override the listen port. Only applies to a fresh install — once
#   # /etc/vaultbase/vaultbase.env exists it is authoritative.
#   curl -fsSL https://get.vaultbase.dev | sudo sh -s -- --port 9000
#
#   # Install but do not start (useful when running behind a reverse proxy
#   # you want to configure first)
#   curl -fsSL https://get.vaultbase.dev | sudo sh -s -- --no-start
#
#   # Verify cosign keyless signature before installing (requires `cosign`
#   # on PATH — install from https://docs.sigstore.dev/cosign/installation/).
#   # Confirms the binary was built and signed by the project's GitHub
#   # Actions runner via the Sigstore Fulcio chain.
#   curl -fsSL https://get.vaultbase.dev | sudo sh -s -- --verify-sig
#
#   # Install the binary somewhere else (no root needed on macOS if you can
#   # write there)
#   curl -fsSL https://get.vaultbase.dev | sh -s -- --install-dir ~/.local/bin
#
# Re-running the script upgrades the binary in place and restarts the service
# if it was running. Existing data dir, config file, JWT secret, setup key and
# admin accounts are preserved.
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
# PORT is pre-seeded with the default, so it cannot tell us whether --port was
# actually passed. Track that separately or an upgrade warns about a flag the
# operator never typed.
PORT_SET=0

# Set during pre-flight / install, read later on the Linux path.
ADDUSER_KIND=""
WAS_ACTIVE=0
SETUP_KEY=""
FRESH_INSTALL=0
BIND_CAPS=""
START_FAILED=0

# ── Output helpers ──────────────────────────────────────────────────────────
say()    { printf '%s\n' "$*"; }
warn()   { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
err()    { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
ok()     { printf '\033[32m✓ %s\033[0m\n' "$*"; }
header() { printf '\n\033[1m── %s ──────────────────────────────────────────\033[0m\n' "$*"; }

die()    { err "$*"; exit 1; }

# Printed by --help. The header comment above is not reachable when the
# script is piped into `sh` ($0 is not a readable file), so the text lives
# here instead.
usage() {
    cat <<'USAGE'
Vaultbase installer for Linux and macOS.

  curl -fsSL https://get.vaultbase.dev | sudo sh

Flags:
  --version <vX.Y.Z>   Pin a release instead of installing the latest.
  --port <n>           Listen port (Linux only, fresh installs only).
  --no-start           Install and enable the unit, but do not start it.
  --no-systemd         Install the binary only; skip the unit entirely.
  --verify-sig         Verify the cosign keyless signature (needs `cosign`).
  --install-dir <dir>  Install the binary somewhere other than /usr/local/bin.
  --help, -h           Show this text.

On Windows, use the PowerShell installer:
  irm https://get.vaultbase.dev/install.ps1 | iex

Re-running upgrades the binary in place and restarts the service. The data
dir, config file, JWT secret and admin accounts are preserved.
USAGE
}

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        # `shift 2` when only one argument remains is a FATAL error in dash
        # (/bin/sh on Debian + Ubuntu), so the `|| die` never runs there and
        # the script dies with "shift: can't shift that many" and exit 2.
        # Check the count first instead.
        --version)    [ $# -ge 2 ] || die "--version needs a value"
                      VERSION="$2"; shift 2 ;;
        --version=*)  VERSION="${1#*=}"; shift ;;
        --port)       [ $# -ge 2 ] || die "--port needs a value"
                      PORT="$2"; PORT_SET=1; shift 2 ;;
        --port=*)     PORT="${1#*=}"; PORT_SET=1; shift ;;
        --no-start)   NO_START=1; shift ;;
        --no-systemd) NO_SYSTEMD=1; shift ;;
        --verify-sig) VERIFY_SIG=1; shift ;;
        --install-dir)   [ $# -ge 2 ] || die "--install-dir needs a value"
                      INSTALL_DIR="$2"; shift 2 ;;
        --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
        --help|-h)    usage; exit 0 ;;
        *)            die "Unknown flag: $1" ;;
    esac
done

# --port lands in the env file and in the final output, and the server runs it
# through parseInt — a non-numeric value would silently become NaN.
case "${PORT}" in
    ''|*[!0-9]*) die "--port must be a number (got: '${PORT}')" ;;
esac
if [ "${PORT}" -lt 1 ] || [ "${PORT}" -gt 65535 ]; then
    die "--port must be between 1 and 65535 (got: ${PORT})"
fi

[ -n "${INSTALL_DIR}" ] || die "--install-dir needs a non-empty path"
case "${INSTALL_DIR}" in
    /*) ;;
    *)  die "--install-dir must be an absolute path (got: ${INSTALL_DIR})" ;;
esac
# Strip trailing slashes so ${INSTALL_DIR}/vaultbase never doubles up.
while :; do
    case "${INSTALL_DIR}" in
        */) INSTALL_DIR="${INSTALL_DIR%/}" ;;
        *)  break ;;
    esac
done

# ── Pre-flight ──────────────────────────────────────────────────────────────
header "Pre-flight"

# OS check. Release assets are named vaultbase-<os>-<arch>.
OS=""
case "$(uname -s)" in
    Linux)  OS="linux"; ok "OS: Linux" ;;
    Darwin) OS="macos"; ok "OS: macOS" ;;
    MINGW*|MSYS*|CYGWIN*)
        die "On Windows, run this in PowerShell instead: irm https://get.vaultbase.dev/install.ps1 | iex" ;;
    *)      die "Unsupported OS: $(uname -s). Supported: Linux, macOS (Windows: install.ps1)." ;;
esac

# Arch detection.
CPU=""
case "$(uname -m)" in
    x86_64|amd64)   CPU="x64" ;;
    aarch64|arm64)  CPU="arm64" ;;
    *)              die "Unsupported architecture: $(uname -m). Supported: x86_64, aarch64 / arm64." ;;
esac

# A shell running under Rosetta reports x86_64 on Apple silicon. Use the
# native arm64 build instead.
if [ "${OS}" = "macos" ] && [ "${CPU}" = "x64" ] \
    && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    CPU="arm64"
    ok "Rosetta shell on Apple silicon — using the native arm64 build"
fi
ARCH="${OS}-${CPU}"

# Detect Alpine / musl — Bun ships separate musl binaries.
MUSL=0
if [ "${OS}" = "linux" ] && { [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); }; then
    MUSL=1
    if [ "${ARCH}" = "linux-x64" ]; then
        ARCH="linux-x64-musl"
        ok "Detected musl libc — using ${ARCH} build"
    else
        die "No musl build for ${CPU} yet. On arm64, use a glibc distro (Debian, Ubuntu) or a glibc container image."
    fi
fi
ok "Architecture: ${ARCH}"

# Linux sets up a system user and a service, so it needs root. macOS only
# installs the binary, so it needs root only when INSTALL_DIR isn't writable.
if [ "${OS}" = "linux" ]; then
    if [ "$(id -u)" -ne 0 ]; then
        die "This installer must run as root on Linux. Re-run with sudo."
    fi
    for cmd in curl install id; do
        command -v "${cmd}" >/dev/null 2>&1 || die "Missing required tool: ${cmd}"
    done
    # `useradd` comes from the `shadow` package and is absent on a stock
    # Alpine install — which is exactly where the musl build is used. Busybox
    # provides `adduser` / `addgroup` instead, with different flags.
    if command -v useradd >/dev/null 2>&1; then
        ADDUSER_KIND="useradd"
    elif command -v adduser >/dev/null 2>&1 && command -v addgroup >/dev/null 2>&1; then
        ADDUSER_KIND="busybox"
    else
        die "Need \`useradd\` (shadow) or \`adduser\`+\`addgroup\` (busybox) to create the service user. On Alpine: apk add shadow"
    fi
    # The musl binary links against libstdc++ and libgcc, which Alpine
    # doesn't ship by default.
    if [ "${MUSL}" -eq 1 ] && [ ! -e /usr/lib/libstdc++.so.6 ]; then
        if command -v apk >/dev/null 2>&1; then
            apk add --no-cache -q libstdc++ libgcc >/dev/null \
                || die "Could not install libstdc++ and libgcc. Run: apk add libstdc++ libgcc"
            ok "Installed libstdc++ and libgcc"
        else
            die "The musl build needs libstdc++ and libgcc. Install them and re-run."
        fi
    fi
    # Alpine's base image ships no `xz`, so without this every musl install
    # downloads the ~100 MB raw binary instead of the ~30 MB compressed one.
    # Non-fatal: the download path falls back to the raw asset.
    if ! command -v xz >/dev/null 2>&1 && command -v apk >/dev/null 2>&1; then
        apk add --no-cache -q xz >/dev/null 2>&1 && ok "Installed xz (smaller download)" || true
    fi
else
    for cmd in curl install; do
        command -v "${cmd}" >/dev/null 2>&1 || die "Missing required tool: ${cmd}"
    done
    if [ -d "${INSTALL_DIR}" ]; then
        [ -w "${INSTALL_DIR}" ] \
            || die "Can't write to ${INSTALL_DIR}. Re-run with sudo, or pass --install-dir <dir>."
    else
        [ -w "$(dirname "${INSTALL_DIR}")" ] \
            || die "Can't create ${INSTALL_DIR}. Re-run with sudo, or pass --install-dir <dir>."
    fi
    if [ "${PORT_SET}" -eq 1 ] || [ "${NO_START}" -eq 1 ]; then
        warn "--port and --no-start only apply on Linux; ignoring them."
    fi
    # Nothing to set up beyond the binary on macOS.
    NO_SYSTEMD=1
fi

# Detect whether systemd is the init system. Containers often run without it.
if [ "${OS}" = "linux" ] && [ "${NO_SYSTEMD}" -eq 0 ]; then
    if [ ! -d /run/systemd/system ]; then
        warn "systemd not detected (no /run/systemd/system). Skipping unit install."
        warn "You will need to run vaultbase under your own supervisor (runit, s6, supervisord, ...)."
        NO_SYSTEMD=1
    fi
fi

# ProtectHome=yes in the unit makes /home and /root invisible to the service,
# so an ExecStart under either can never start. Catch it here rather than
# after the unit is written and `systemctl start` fails with status=203.
if [ "${OS}" = "linux" ] && [ "${NO_SYSTEMD}" -eq 0 ]; then
    case "${INSTALL_DIR}" in
        /home/*|/root|/root/*)
            die "--install-dir ${INSTALL_DIR} is incompatible with the hardened systemd unit: ProtectHome=yes hides it from the service. Use a path outside /home and /root, or pass --no-systemd." ;;
    esac
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

# Download $1 to $2. On a terminal, curl's progress bar shows the transfer
# (a silent 70 MB download looked frozen). A connection that stays under
# SLOW_BPS for SLOW_SECS is dropped and retried on a new one (one
# connection was seen crawling at ~100 KB/s while a fresh one from the same
# host ran at ~20 MB/s), then one last attempt runs without the floor, so a
# genuinely slow link still finishes. Any other failure (e.g. a 404) returns
# at once.
SLOW_BPS=102400
SLOW_SECS=30
download() {
    if [ -t 2 ]; then _dl_quiet="--progress-bar"; else _dl_quiet="-s"; fi
    # curl's --retry treats "too slow" (28) as transient and reconnects.
    _dl_rc=0
    curl -fSL ${_dl_quiet} --retry 3 --retry-delay 1 \
        --speed-limit "${SLOW_BPS}" --speed-time "${SLOW_SECS}" \
        -o "$2" "$1" || _dl_rc=$?
    [ "${_dl_rc}" -eq 28 ] || return "${_dl_rc}"
    warn "Still slow after retries — downloading without the speed check; this may take a while."
    curl -fSL ${_dl_quiet} --retry 3 --retry-delay 2 -o "$2" "$1"
}

# Human-readable size of a remote file (follows redirects), or empty.
remote_size() {
    _rs_len="$(curl -fsSLI --max-time 10 "$1" 2>/dev/null \
        | awk 'tolower($1) == "content-length:" { n = $2 } END { gsub(/\r/, "", n); print n }')"
    case "${_rs_len}" in
        ''|*[!0-9]*|0) printf '' ;;
        *) awk -v n="${_rs_len}" 'BEGIN { printf " (%.0f MB)", n / 1048576 }' ;;
    esac
}

# Prefer the xz-compressed asset (~30 MB instead of ~100 MB). Releases before
# compressed assets existed, or hosts without `xz`, fall back to the raw
# binary. Checksum + signature checks below run on the decompressed binary,
# so they are identical on both paths.
# Only the Linux binaries are published as .xz.
FETCHED=0
if [ "${OS}" = "linux" ] && command -v xz >/dev/null 2>&1; then
    # Probe first, so a release without .xz assets falls back quietly.
    XZ_SIZE="$(remote_size "${URL}.xz")"
    if [ -n "${XZ_SIZE}" ]; then
        say "Fetching ${URL}.xz${XZ_SIZE}..."
        download "${URL}.xz" "${TMP}/vaultbase.xz" \
            || die "Download failed. Check ${RELEASES_URL} for available assets and the network from this host."
        xz -dc "${TMP}/vaultbase.xz" > "${TMP}/vaultbase" \
            || { err "Could not decompress ${URL}.xz"; exit 2; }
        rm -f "${TMP}/vaultbase.xz"
        FETCHED=1
    else
        warn "No compressed asset for ${VERSION} — downloading the raw binary."
    fi
fi
if [ "${FETCHED}" -eq 0 ]; then
    say "Fetching ${URL}$(remote_size "${URL}")..."
    download "${URL}" "${TMP}/vaultbase" \
        || die "Download failed. Check ${RELEASES_URL} for available assets and the network from this host."
fi

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

# ── macOS: install the binary and stop ─────────────────────────────────────
if [ "${OS}" = "macos" ]; then
    header "Install binary"

    install -d -m 0755 "${INSTALL_DIR}"
    install -m 0755 "${TMP}/vaultbase" "${INSTALL_DIR}/vaultbase.new"
    mv -f "${INSTALL_DIR}/vaultbase.new" "${INSTALL_DIR}/vaultbase"
    ok "Installed ${INSTALL_DIR}/vaultbase"

    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) RUN="vaultbase" ;;
        *)  RUN="${INSTALL_DIR}/vaultbase"
            warn "${INSTALL_DIR} is not on your PATH." ;;
    esac

    header "Done"
    cat <<EOF

  Vaultbase ${VERSION} installed to ${INSTALL_DIR}/vaultbase.

  Next steps:

    1. Start it. Data goes in ./vaultbase_data unless VAULTBASE_DATA_DIR is set:
         ${RUN}

    2. Open http://localhost:${DEFAULT_PORT}/_/ to create your admin account.

  Re-run this script any time to upgrade the binary in place.

EOF
    exit 0
fi

# ── User + dirs ─────────────────────────────────────────────────────────────
header "Service user + directories"

# `nologin` is /usr/sbin/nologin on Debian + RHEL and /sbin/nologin on Alpine.
NOLOGIN="/bin/false"
for candidate in /usr/sbin/nologin /sbin/nologin; do
    if [ -x "${candidate}" ]; then NOLOGIN="${candidate}"; break; fi
done

# Create the group up front, independently of the user. A `vaultbase` user
# that already exists under a different primary group (a distro package, or
# `useradd -g nogroup`) used to skip creation entirely and then abort below
# with a bare `install: invalid group 'vaultbase'`. Both tools tolerate an
# existing group, so this is safe to attempt unconditionally.
if [ "${ADDUSER_KIND}" = "useradd" ]; then
    groupadd --system "${SVC_GROUP}" 2>/dev/null || true
else
    addgroup -S "${SVC_GROUP}" 2>/dev/null || true
fi

if id -u "${SVC_USER}" >/dev/null 2>&1; then
    ok "User '${SVC_USER}' already exists"
elif [ "${ADDUSER_KIND}" = "useradd" ]; then
    useradd --system --no-create-home --shell "${NOLOGIN}" -g "${SVC_GROUP}" "${SVC_USER}"
    ok "Created system user '${SVC_USER}'"
else
    # busybox: -S system account, -D no password, -H no home dir.
    adduser -S -D -H -s "${NOLOGIN}" -G "${SVC_GROUP}" "${SVC_USER}"
    ok "Created system user '${SVC_USER}'"
fi

# If the group still does not resolve, say so in terms the operator can act
# on rather than letting `install -g` fail with a bare coreutils message.
GROUP_HINT="Create it and re-run. On glibc: groupadd --system ${SVC_GROUP} && usermod -g ${SVC_GROUP} ${SVC_USER}. On Alpine: addgroup -S ${SVC_GROUP} && adduser ${SVC_USER} ${SVC_GROUP}"

if [ -d "${DATA_DIR}" ]; then
    # Existing data dir: fix ownership so the service can write, but leave the
    # mode alone — an operator may have tightened it to 0700 deliberately.
    chown "${SVC_USER}:${SVC_GROUP}" "${DATA_DIR}" \
        || die "Could not chown ${DATA_DIR} to ${SVC_USER}:${SVC_GROUP}. ${GROUP_HINT}"
else
    install -d -m 0750 -o "${SVC_USER}" -g "${SVC_GROUP}" "${DATA_DIR}" \
        || die "Could not create ${DATA_DIR} owned by ${SVC_USER}:${SVC_GROUP}. ${GROUP_HINT}"
fi
install -d -m 0755 -o root -g root "${ETC_DIR}"
ok "Data dir: ${DATA_DIR}"
ok "Config dir: ${ETC_DIR}"

# ── Env file (preserve existing secrets) ───────────────────────────────────
if [ -f "${ENV_FILE}" ]; then
    ok "Existing ${ENV_FILE} — keeping JWT secret + values"
    # Once the env file exists it is authoritative: the service reads its port
    # from there, not from this run's --port. Read the live value back so the
    # health-check URL printed at the end is the one that actually works.
    LIVE_PORT="$(awk -F= '/^[[:space:]]*VAULTBASE_PORT[[:space:]]*=/ { gsub(/[^0-9]/, "", $2); print $2 }' "${ENV_FILE}" | tail -n 1)"
    case "${LIVE_PORT}" in
        ''|*[!0-9]*) LIVE_PORT="${DEFAULT_PORT}" ;;
    esac
    if [ "${PORT_SET}" -eq 1 ] && [ "${PORT}" != "${LIVE_PORT}" ]; then
        warn "--port ${PORT} ignored: ${ENV_FILE} already sets VAULTBASE_PORT=${LIVE_PORT}."
        warn "To change it, edit ${ENV_FILE} and run 'systemctl restart vaultbase'."
    fi
    PORT="${LIVE_PORT}"
else
    FRESH_INSTALL=1
    JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
    # Gates the unauthenticated first-admin endpoint. Generated per install so
    # a fresh box on a public IP is never claimable by whoever reaches it
    # first. `vaultbase setup-admin` does not need it; only the web page does.
    SETUP_KEY="$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
    umask 077
    if [ "${NO_SYSTEMD}" -eq 0 ]; then
        RESTART_HINT="run \`systemctl restart vaultbase\`"
    else
        RESTART_HINT="restart vaultbase"
    fi
    cat > "${ENV_FILE}" <<EOF
# Vaultbase configuration — generated by the installer on $(date -u +%FT%TZ)
# Override any of these and ${RESTART_HINT} to apply.

VAULTBASE_PORT=${PORT}
VAULTBASE_DATA_DIR=${DATA_DIR}

# Persisted JWT signing key. Loss = every issued token is invalidated.
# Rotate by changing this value and forcing all clients to reauthenticate.
VAULTBASE_JWT_SECRET=${JWT_SECRET}

# Key for POST /api/v1/admin/setup (and the browser setup page's "Setup key"
# field) until the first admin exists. Without it the server would generate
# and print its own. \`vaultbase setup-admin\` doesn't need it.
VAULTBASE_SETUP_KEY=${SETUP_KEY}

# Optional: required only if you use encrypted fields.
# Generate with: head -c 32 /dev/urandom | base64
# VAULTBASE_ENCRYPTION_KEY=

# Optional: peer addresses allowed to set X-Forwarded-For, comma-separated.
# Set this to your reverse proxy, otherwise the client IPs in the audit log
# and the rate limiter are the proxy's rather than the caller's.
# VAULTBASE_TRUSTED_PROXIES=127.0.0.1

# CORS allowed origins are not an env var — set \`security.allowed_origins\`
# under Settings in the admin UI.
EOF
    umask 022
    ok "Wrote ${ENV_FILE} (mode 0640) with a fresh JWT secret + setup key"
fi

# Unconditional, not just on creation: an env file left at 0644 by an older
# installer or by hand keeps the JWT signing key and the setup key readable by
# every local user. Re-running the installer is the documented repair path, so
# it has to actually repair this.
chown root:"${SVC_GROUP}" "${ENV_FILE}" \
    || die "Could not chown ${ENV_FILE} to root:${SVC_GROUP}. ${GROUP_HINT}"
if [ "${FRESH_INSTALL}" -eq 0 ]; then
    # `stat -c` is fine here: this block is Linux-only (macOS exits earlier)
    # and busybox stat supports it too.
    OLD_MODE="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || echo '')"
    chmod 0640 "${ENV_FILE}"
    if [ -n "${OLD_MODE}" ] && [ "${OLD_MODE}" != "640" ]; then
        warn "Tightened ${ENV_FILE} from mode ${OLD_MODE} to 0640 — it holds the JWT signing key."
    fi
else
    chmod 0640 "${ENV_FILE}"
fi

# ── Install binary (atomic) ─────────────────────────────────────────────────
header "Install binary"

# Must be sampled before the swap: `systemctl enable --now` is a no-op on a
# unit that is already active, so an upgrade would otherwise leave the old
# process serving the old binary while reporting success.
if [ "${NO_SYSTEMD}" -eq 0 ] && systemctl is-active --quiet vaultbase 2>/dev/null; then
    WAS_ACTIVE=1
fi

install -d -m 0755 "${INSTALL_DIR}"
install -m 0755 -o root -g root "${TMP}/vaultbase" "${INSTALL_DIR}/vaultbase.new"
# rename() over a running binary swaps the inode; the live process keeps its
# own mapping until it is restarted below.
mv -f "${INSTALL_DIR}/vaultbase.new" "${INSTALL_DIR}/vaultbase"
ok "Installed ${INSTALL_DIR}/vaultbase"

# ── systemd unit ────────────────────────────────────────────────────────────
# The unit runs as an unprivileged user with an empty capability set, so a
# port below 1024 fails bind() with EACCES no matter how valid the number is.
# Grant the single capability that covers it; stays empty otherwise, which is
# the common case.
if [ "${PORT}" -lt 1024 ]; then
    BIND_CAPS="CAP_NET_BIND_SERVICE"
    warn "Port ${PORT} is privileged — granting the unit CAP_NET_BIND_SERVICE."
    warn "A reverse proxy on 80/443 forwarding to a high port is usually preferable."
fi

if [ "${NO_SYSTEMD}" -eq 0 ]; then
    header "systemd unit"

    # systemd is running (we checked /run/systemd/system), but the unit
    # directory is not guaranteed to exist — on a minimal image the `cat >`
    # below would abort the script after the binary is already installed.
    install -d -m 0755 "${UNIT_FILE%/*}"

    # Unquoted heredoc: the paths and the service account come from the
    # variables above, so there is nothing left to rewrite afterwards. (The
    # old `sed -i` pass over ExecStart broke on any INSTALL_DIR containing
    # a `|` or `&`.) Because it is unquoted, the unit body below must stay
    # free of unescaped `$` and backticks — including inside its comments.
    cat > "${UNIT_FILE}" <<UNIT
[Unit]
Description=Vaultbase backend
Documentation=https://docs.vaultbase.dev
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_GROUP}
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/vaultbase
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
# SystemCallFilter was removed: Bun uses syscalls outside the
# @system-service set (notably some io_uring + mmap variants), which
# triggers SIGSYS and a core dump under seccomp. The hardening above is
# enough to neutralise the typical privilege-escalation paths.

# Vaultbase only needs to write inside its data dir. ProtectSystem=strict
# makes /etc/vaultbase read-only from the service's view (config is read once).
ReadWritePaths=${DATA_DIR}
# Empty unless --port (or VAULTBASE_PORT) is below 1024, where bind() needs
# CAP_NET_BIND_SERVICE. Change the port in the env file and re-run the
# installer so this is recalculated.
CapabilityBoundingSet=${BIND_CAPS}
AmbientCapabilities=${BIND_CAPS}

[Install]
WantedBy=multi-user.target
UNIT
    chmod 0644 "${UNIT_FILE}"
    ok "Wrote ${UNIT_FILE}"

    systemctl daemon-reload \
        || warn "systemctl daemon-reload failed — systemd may not see the new unit yet."

    # Every systemctl call below is guarded. Under `set -e` an unguarded
    # failure here would abort the script before the summary block, so a
    # service that fails to start would take the journalctl hint, the config
    # paths and the generated setup key down with it — exactly the case the
    # warning exists for. Let `is-active` do the reporting instead.
    if [ "${NO_START}" -eq 0 ]; then
        if [ "${WAS_ACTIVE}" -eq 1 ]; then
            # Already running: restart so the new binary actually takes over.
            systemctl enable vaultbase >/dev/null 2>&1 || true
            systemctl restart vaultbase || true
        else
            systemctl enable --now vaultbase || true
        fi
        sleep 1
        if systemctl is-active --quiet vaultbase; then
            if [ "${WAS_ACTIVE}" -eq 1 ]; then
                ok "vaultbase restarted onto ${VERSION}"
            else
                ok "vaultbase service is active"
            fi
        else
            START_FAILED=1
            warn "vaultbase is not running. Inspect logs: journalctl -u vaultbase -n 50"
            warn "The binary and config below are in place; fix the cause and 'systemctl start vaultbase'."
        fi
    else
        systemctl enable vaultbase || true
        if [ "${WAS_ACTIVE}" -eq 1 ]; then
            warn "--no-start: the service is still running the previous binary."
            warn "Run 'systemctl restart vaultbase' to finish the upgrade."
        else
            ok "Service enabled (use 'systemctl start vaultbase' when ready)"
        fi
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

if [ "${FRESH_INSTALL}" -eq 1 ]; then
    cat <<EOF
  Next steps:

    1. Bootstrap an admin account. The CLI reads ${ENV_FILE}
       for the database path; run it as '${SVC_USER}' so the files
       stay owned by the service:

         sudo -u ${SVC_USER} ${INSTALL_DIR}/vaultbase setup-admin \\
           --email you@example.com --password '<pw>'

    2. Put a reverse proxy in front. Sample configs:
         https://docs.vaultbase.dev/getting-started/installation/

       Then set VAULTBASE_TRUSTED_PROXIES in ${ENV_FILE} to the
       proxy's address, or every client IP in the audit log and the rate
       limiter will be the proxy's.

    3. Health check:
         curl http://127.0.0.1:${PORT}/api/health

EOF
else
    # Upgrade: the admin account and proxy are already dealt with. Repeating
    # step 1 here would send the operator at \`setup-admin\`, which refuses
    # with "an admin already exists".
    cat <<EOF
  Upgrade complete — data, config and admin accounts are unchanged.

    Health check:
      curl http://127.0.0.1:${PORT}/api/health

    If you have not created an admin account yet:
      sudo -u ${SVC_USER} env VAULTBASE_DATA_DIR=${DATA_DIR} \\
        ${INSTALL_DIR}/vaultbase setup-admin --email you@example.com --password '<pw>'

EOF
fi

if [ "${NO_SYSTEMD}" -eq 0 ]; then
    cat <<EOF
  Re-run this script any time to upgrade the binary in place and restart the
  service. Your data, config, and admin accounts are preserved.

EOF
else
    cat <<EOF
  Re-run this script any time to upgrade the binary in place. Restarting
  vaultbase under your supervisor is up to you. Your data, config, and admin
  accounts are preserved.

EOF
fi

# The generated setup key gates first-admin setup. Call it out explicitly,
# because the browser setup page asks for it.
if [ -n "${SETUP_KEY}" ]; then
    cat <<EOF
  First-admin endpoint is gated
  ─────────────────────────────

  Creating the first admin over HTTP needs a setup key. The installer
  generated one and stored it in ${ENV_FILE}:

    VAULTBASE_SETUP_KEY=${SETUP_KEY}

  Step 1 above does not need it. To use the browser setup page instead, open
  http://127.0.0.1:${PORT}/_/setup#key=${SETUP_KEY}
  (or paste the key into its Setup key field). Over curl, send it as a header:

    curl -X POST http://127.0.0.1:${PORT}/api/v1/admin/setup \\
      -H 'content-type: application/json' \\
      -H 'x-setup-key: ${SETUP_KEY}' \\
      -d '{"email":"you@example.com","password":"<pw>"}'


EOF
fi

# Non-zero exit when the service did not come up, so a caller wrapping this
# script notices. The summary above has already been printed either way.
if [ "${START_FAILED}" -eq 1 ]; then
    exit 1
fi
