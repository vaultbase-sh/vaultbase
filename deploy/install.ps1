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
#   # With options: pin a version, pick a folder, verify the cosign signature
#   # (needs `cosign` on PATH)
#   & ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -Version v0.16.0
#   & ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -InstallDir C:\tools\vaultbase -VerifySig
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
    [switch]$NoPath
)

function Install-Vaultbase {
    param([string]$Version, [string]$InstallDir, [bool]$VerifySig, [bool]$NoPath)

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
        } else {
            Warn "No SHA256SUMS published for this release - skipping integrity check."
        }

        if ($VerifySig) {
            if (-not (Get-Command cosign -ErrorAction SilentlyContinue)) {
                throw "-VerifySig needs cosign on PATH. Install: https://docs.sigstore.dev/cosign/installation/"
            }
            Write-Host "Fetching cosign signature + certificate..."
            Invoke-WebRequest -Uri "$Url.sig" -OutFile "$Exe.sig" -UseBasicParsing
            Invoke-WebRequest -Uri "$Url.pem" -OutFile "$Exe.pem" -UseBasicParsing
            & cosign verify-blob `
                --certificate "$Exe.pem" `
                --signature "$Exe.sig" `
                --certificate-identity-regexp "^https://github\.com/$Repo/" `
                --certificate-oidc-issuer "https://token.actions.githubusercontent.com" `
                $Exe
            if ($LASTEXITCODE -ne 0) { throw "Cosign verification failed." }
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
    Install-Vaultbase -Version $Version -InstallDir $InstallDir -VerifySig:$VerifySig.IsPresent -NoPath:$NoPath.IsPresent
} catch {
    # Write the error and stop without `exit`, which would close the shell
    # that ran `irm ... | iex`.
    Write-Host "x  $($_.Exception.Message)" -ForegroundColor Red
}
