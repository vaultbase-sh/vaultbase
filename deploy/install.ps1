# Vaultbase one-shot installer for Windows.
#
# Downloads the Windows binary from GitHub releases, checks it against the
# release's SHA256SUMS, installs it to %LOCALAPPDATA%\Programs\Vaultbase and
# adds that folder to your user PATH. No admin rights needed.
#
# Usage (PowerShell 5.1 or 7+):
#
#   irm https://get.vaultbase.dev/install.ps1 | iex
#
#   # The cosign keyless signature is verified by default whenever `cosign`
#   # is on PATH; without it the installer says so and relies on SHA256SUMS
#   # alone. -VerifySig requires the check (fails without cosign);
#   # -NoVerifySig skips it (releases too old to be signed).
#   & ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -Version v0.45.1
#   & ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -InstallDir C:\tools\vaultbase -VerifySig
#   & ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -Version v0.1.0 -NoVerifySig
#
#   # A release too old to publish SHA256SUMS: the checksum is otherwise
#   # required, and a missing one stops the install
#   & ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -Version v0.1.0 -SkipChecksum
#
# Re-running the script upgrades the binary in place. Stop any running
# vaultbase.exe first.
#
# Linux and macOS: use install.sh instead:
#   curl -fsSL https://get.vaultbase.dev | sudo sh

param(
    [string]$Version = "",
    [string]$InstallDir = "",
    [switch]$VerifySig,
    [switch]$NoVerifySig,
    [switch]$NoPath,
    [switch]$SkipChecksum
)

function Install-Vaultbase {
    param([string]$Version, [string]$InstallDir, [bool]$VerifySig, [bool]$NoVerifySig, [bool]$NoPath, [bool]$SkipChecksum)

    $ErrorActionPreference = "Stop"
    # Invoke-WebRequest's progress bar makes large downloads very slow on 5.1.
    $ProgressPreference = "SilentlyContinue"
    # Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $Repo = "vaultbase-sh/vaultbase"
    $ReleasesUrl = "https://github.com/$Repo/releases"
    $Asset = "vaultbase-windows-x64.exe"

    function Ok([string]$m)   { Write-Host "OK $m" -ForegroundColor Green }
    function Warn([string]$m) { Write-Host "!  $m" -ForegroundColor Yellow }
    function Header([string]$m) { Write-Host ""; Write-Host "== $m ==" }

    # -- Pre-flight ----------------------------------------------------------
    Header "Pre-flight"

    if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
        throw "This installer is for Windows. On Linux or macOS run: curl -fsSL https://get.vaultbase.dev | sudo sh"
    }
    Ok "OS: Windows"

    # A 32-bit PowerShell on 64-bit Windows reports x86 here and the real
    # architecture in PROCESSOR_ARCHITEW6432.
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($cpu) {
        "AMD64" { Ok "Architecture: x64" }
        "ARM64" { Warn "Windows on ARM: there is no native arm64 build, so the x64 binary runs under emulation." }
        default { throw "Unsupported architecture: $cpu. Vaultbase ships a 64-bit (x64) Windows build only." }
    }

    if ($VerifySig -and $NoVerifySig) { throw "-VerifySig and -NoVerifySig can't be used together." }

    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Vaultbase" }

    # -- Resolve version -----------------------------------------------------
    Header "Resolve release"

    if (-not $Version) {
        $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "vaultbase-installer" }
        $Version = $latest.tag_name
        if (-not $Version) { throw "Could not resolve the latest release tag. Check $ReleasesUrl" }
        Ok "Latest release: $Version"
    } else {
        if (-not $Version.StartsWith("v")) { $Version = "v$Version" }
        Ok "Pinned release: $Version"
    }
    # The tag goes into download URLs and the cosign identity regexp, so
    # accept only what release.yml publishes. -cmatch with \z: `$` would also
    # match before a trailing newline.
    if (-not ($Version -cmatch '^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\z')) {
        throw "Not a release version: '$Version' (expected vX.Y.Z)"
    }

    $Url = "$ReleasesUrl/download/$Version/$Asset"

    # -- Download + verify ---------------------------------------------------
    Header "Download"

    $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("vaultbase-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $Tmp | Out-Null
    try {
        $Exe = Join-Path $Tmp "vaultbase.exe"
        Write-Host "Fetching $Url..."
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Exe -UseBasicParsing
        } catch {
            throw "Download failed ($($_.Exception.Message)). Check $ReleasesUrl for available assets."
        }

        # The Windows binary has no per-file .sha256; the combined SHA256SUMS
        # covers every asset.
        $Sums = Join-Path $Tmp "SHA256SUMS"
        $haveSums = $true
        try {
            Invoke-WebRequest -Uri "$ReleasesUrl/download/$Version/SHA256SUMS" -OutFile $Sums -UseBasicParsing
        } catch {
            $haveSums = $false
        }
        if ($haveSums) {
            $line = Get-Content $Sums | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($Asset))$" } | Select-Object -First 1
            if (-not $line) { throw "SHA256SUMS has no entry for $Asset." }
            $expected = ($line -split "\s+")[0].ToLower()
            $actual = (Get-FileHash -Algorithm SHA256 -Path $Exe).Hash.ToLower()
            if ($expected -ne $actual) { throw "SHA-256 mismatch. expected=$expected actual=$actual" }
            Ok "SHA-256 verified"
        } elseif ($SkipChecksum) {
            Warn "No SHA256SUMS for this release - installing without the integrity check (-SkipChecksum)."
        } else {
            # A failed fetch used to install an unchecked binary with only a warning.
            throw "Couldn't fetch SHA256SUMS, so the download can't be checked. Retry, or pass -SkipChecksum for a release that has none."
        }

        # SHA256SUMS comes from the same release as the binary, so whoever can
        # replace one can replace both; the signature ties the binary to this
        # repository's release.yml run for this tag. Checked by default when
        # cosign is on PATH; a release with no signature then fails the install.
        $checkSig = -not $NoVerifySig
        if ($checkSig -and -not (Get-Command cosign -ErrorAction SilentlyContinue)) {
            if ($VerifySig) {
                throw "-VerifySig needs cosign on PATH. Install: https://docs.sigstore.dev/cosign/installation/"
            }
            Warn "cosign is not on PATH, so the release signature was NOT verified."
            Warn "Only SHA256SUMS from the same release was checked; it cannot detect release assets replaced after publication."
            Warn "Install cosign (https://docs.sigstore.dev/cosign/installation/) and re-run to verify, or pass -VerifySig to require it."
            $checkSig = $false
        }
        if ($checkSig) {
            # The release workflow, started from this very tag.
            $identity = "^https://github\.com/$Repo/\.github/workflows/release\.yml@refs/tags/$([regex]::Escape($Version))`$"
            $issuer = "https://token.actions.githubusercontent.com"
            $verified = $false
            # A Sigstore bundle (releases from v0.39.1 on) is what current
            # cosign expects; --certificate/--signature are deprecated there.
            # Releases without one, or a cosign too old to read it, use the
            # .sig/.pem pair.
            Write-Host "Fetching cosign signature..."
            $haveBundle = $true
            try { Invoke-WebRequest -Uri "$Url.sigstore.json" -OutFile "$Exe.sigstore.json" -UseBasicParsing } catch { $haveBundle = $false }
            if ($haveBundle) {
                & cosign verify-blob --bundle "$Exe.sigstore.json" `
                    --certificate-identity-regexp $identity `
                    --certificate-oidc-issuer $issuer `
                    $Exe
                if ($LASTEXITCODE -eq 0) { $verified = $true }
                else { Warn "The Sigstore bundle didn't verify with this cosign; trying the .sig/.pem pair." }
            }
            if (-not $verified) {
                try {
                    Invoke-WebRequest -Uri "$Url.sig" -OutFile "$Exe.sig" -UseBasicParsing
                    Invoke-WebRequest -Uri "$Url.pem" -OutFile "$Exe.pem" -UseBasicParsing
                } catch {
                    throw "Could not fetch the signature for $Asset ($($_.Exception.Message)). Releases before signing have none: pass -NoVerifySig to install one without the signature check."
                }
                & cosign verify-blob `
                    --certificate "$Exe.pem" `
                    --signature "$Exe.sig" `
                    --certificate-identity-regexp $identity `
                    --certificate-oidc-issuer $issuer `
                    $Exe
                if ($LASTEXITCODE -ne 0) { throw "Cosign verification failed." }
            }
            Ok "Cosign signature verified - binary built by $Repo GitHub Actions"
        }

        # -- Install ---------------------------------------------------------
        Header "Install binary"

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        $Target = Join-Path $InstallDir "vaultbase.exe"
        try {
            Copy-Item -Path $Exe -Destination $Target -Force
        } catch {
            throw "Could not write $Target. If vaultbase is running, stop it and re-run the installer."
        }
        Ok "Installed $Target"
    } finally {
        Remove-Item -Recurse -Force -Path $Tmp -ErrorAction SilentlyContinue
    }

    # -- PATH ----------------------------------------------------------------
    $onPath = ($env:Path -split ";") -contains $InstallDir
    if (-not $NoPath) {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $entries = if ($userPath) { $userPath -split ";" | Where-Object { $_ } } else { @() }
        if ($entries -notcontains $InstallDir) {
            [Environment]::SetEnvironmentVariable("Path", (($entries + $InstallDir) -join ";"), "User")
            Ok "Added $InstallDir to your user PATH (new terminals pick it up)"
        }
        if (-not $onPath) { $env:Path = "$env:Path;$InstallDir" }
        $onPath = $true
    }
    $run = if ($onPath) { "vaultbase" } else { $Target }

    # -- Done ----------------------------------------------------------------
    Header "Done"
    Write-Host @"

  Vaultbase $Version installed to $Target.

  Next steps:

    1. Start it. Data goes in .\vaultbase_data unless VAULTBASE_DATA_DIR is set:
         $run

    2. Open http://localhost:8091/_/ to create your admin account.

  Re-run this installer any time to upgrade the binary in place.

"@
}

try {
    Install-Vaultbase -Version $Version -InstallDir $InstallDir -VerifySig:$VerifySig.IsPresent -NoVerifySig:$NoVerifySig.IsPresent -NoPath:$NoPath.IsPresent -SkipChecksum:$SkipChecksum.IsPresent
} catch {
    # Write the error and stop without `exit`, which would close the shell
    # that ran `irm ... | iex`.
    Write-Host "x  $($_.Exception.Message)" -ForegroundColor Red
}
