# One-shot owner-authorized build + guarded in-place Codexify upgrade.
# Must run in a separate elevated PowerShell, NEVER from the Codexify service.
# Does not alter either signed-in Chrome profile or fabricate pairing receipts.
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$ForceMaintenance,
    [ValidateRange(1,120)][int]$WaitTimeoutMinutes = 10
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $Apply -or -not $ForceMaintenance) {
    throw 'Explicit -Apply -ForceMaintenance is required for this one-shot updater'
}
if ($env:OS -ne 'Windows_NT') { throw 'Windows PowerShell is required' }
$systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $systemTar -PathType Leaf)) {
    throw 'Windows System32 tar.exe is required for verified package extraction'
}
# nvm-windows installations can omit System32 from the inherited PATH.
$env:Path = (Split-Path -Parent $systemTar) + ';' + $env:Path
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open a separate PowerShell window using Run as administrator'
}
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$companion = Join-Path $repo 'browser-companion'
$homeDir = Join-Path $env:USERPROFILE '.codexify'
$cfgPath = Join-Path $homeDir 'codexify.config.json'
$nativeTarget = Join-Path $homeDir 'bin\codexify.exe'
$installer = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$preflight = Join-Path $PSScriptRoot 'preflight-two-browser-rollout.ps1'
foreach ($path in @($cfgPath, $nativeTarget, $installer, $preflight,
        (Join-Path $companion 'node_modules\electron-builder\out\cli\cli.js'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required installed file/dependency not found: $path"
    }
}
$cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
$primaryKey = [string]$cfg.agentChat.automation.pilotPrimaryTaskKey
$canaryKey = [string]$cfg.agentChat.automation.canaryTaskKey
if ($primaryKey -notmatch '^[a-f0-9]{64}$' -or
    $canaryKey -notmatch '^[a-f0-9]{64}$' -or $primaryKey -ceq $canaryKey) {
    throw 'Existing two-task pilot keys are missing, malformed or identical'
}

function AssertNativeExit([string]$operation) {
    if ($LASTEXITCODE -ne 0) { throw "$operation failed (exit code $LASTEXITCODE)" }
}

Write-Host '=== VERIFY LOCAL UPDATER GUARDS ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -HandoffGuardTest
AssertNativeExit 'Maintenence guard fixture tests'

Push-Location $repo
try {
    Write-Host '=== BUILD UPDATED NATIVE CODEXIFY ==='
    & cargo.exe build --bin codexify --jobs 2 --offline
    AssertNativeExit 'Cargo native build'
} finally {
    Pop-Location
}

function Resolve-BunExecutable {
    $available = Get-Command bun.exe -ErrorAction SilentlyContinue
    if ($available -and $available.Source -and (Test-Path -LiteralPath $available.Source -PathType Leaf)) {
        return [string]$available.Source
    }
    # npm installed via nvm-windows puts bun.cmd in the global prefix, but
    # bun.exe inside node_modules/bun/bin. Discover the real executable rather
    # than guessing that the global prefix itself contains bun.exe.
    $npm = Get-Command npm.cmd -ErrorAction Stop
    $prefix = ((& $npm.Source prefix -g | Select-Object -Last 1) -as [string]).Trim()
    AssertNativeExit 'npm global prefix lookup'
    $candidates = @(
        (Join-Path $prefix 'node_modules\bun\bin\bun.exe'),
        (Join-Path $prefix 'bun.exe'),
        (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            # package.cjs itself spawns 'bun' with shell:false. Its child
            # process must inherit a PATH containing a genuine bun.exe.
            $env:Path = (Split-Path -Parent $candidate) + ';' + $env:Path
            return $candidate
        }
    }
    return $null
}

Write-Host '=== CHECK BROWSER TOOLCHAIN ==='
$bunExecutable = Resolve-BunExecutable
if (-not $bunExecutable) {
    $npm = Get-Command npm.cmd -ErrorAction Stop
    Write-Host 'Installing missing Bun 1.4.4 from the official npm package'
    & $npm.Source install -g bun@1.4.4 --no-audit --no-fund
    AssertNativeExit 'Bun installation'
    $bunExecutable = Resolve-BunExecutable
    if (-not $bunExecutable) { throw 'Bun was installed, but the actual bun.exe could not be located' }
}
Write-Host ('BUN_EXECUTABLE=' + $bunExecutable)
& $bunExecutable --version
AssertNativeExit 'Bun version'

# Pin both the packager and its smoke test to the same local output; ignore
# any inherited artifact overrides from an unrelated developer session.
$cargoVersion = (Select-String -LiteralPath (Join-Path $repo 'Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"' |
    Select-Object -First 1).Matches.Groups[1].Value
if (-not $cargoVersion) { throw 'Cannot determine Cargo version' }
$packageRootName = "codexify-browser-v$cargoVersion-windows-x64"
$env:CODEXIFY_BROWSER_ARTIFACTS = Join-Path $companion 'artifacts'
$artifact = Join-Path $env:CODEXIFY_BROWSER_ARTIFACTS ($packageRootName + '.zip')
$env:CODEXIFY_BROWSER_ARTIFACT = $artifact

Push-Location $companion
try {
    Write-Host '=== TYPECHECK BROWSER COMPANION ==='
    & node.exe .\node_modules\typescript\bin\tsc --noEmit --project tsconfig.json
    AssertNativeExit 'Companion TypeScript check'
    Write-Host '=== BUILD AND PACKAGE BROWSER COMPANION ==='
    & $bunExecutable run build
    AssertNativeExit 'Bun browser build'
    & node.exe .\scripts\package.cjs --platform win32 --arch x64
    AssertNativeExit 'Browser package'
    & node.exe .\scripts\smoke-package.cjs
    AssertNativeExit 'Packaged browser smoke test'
} finally {
    Pop-Location
}

# The official packager writes a verified distributable ZIP. Copy ONLY its
# freshly built app.asar into the staging candidate. Existing private Chrome
# and Electron support files remain unchanged for the installer's compatibility
# check, and production ~/.codexify files are untouched until its transaction.
$candidate = Join-Path $companion 'release\win-unpacked\resources\app.asar'
if (-not (Test-Path -LiteralPath $artifact -PathType Leaf) -or
    -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw 'Verified companion artifact or existing candidate staging path is missing'
}
$scratch = Join-Path $env:TEMP ('codexify-verified-candidate-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratch -ErrorAction Stop)
try {
    Write-Host '=== STAGE VERIFIED BROWSER ASAR ==='
    & $systemTar -xf $artifact -C $scratch
    AssertNativeExit 'Companion archive extraction'
    $asarSource = Join-Path $scratch ($packageRootName + '\app\resources\app.asar')
    if (-not (Test-Path -LiteralPath $asarSource -PathType Leaf)) {
        throw 'Packaged app.asar is missing'
    }
    $staged = $candidate + '.stage-' + [Guid]::NewGuid().ToString('N')
    $oldCandidate = $candidate + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $asarSource -Destination $staged -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $asarSource -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash) {
        throw 'Staged app.asar checksum does not match the packaged artifact'
    }
    [IO.File]::Replace($staged, $candidate, $oldCandidate, $true)
} finally {
    if (Test-Path -LiteralPath $scratch) {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '=== INDEPENDENT PRE-INSTALL GATES ==='
$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $preflight -CanaryTaskKey $canaryKey 2>&1
$preflightExit = $LASTEXITCODE
if ($preflightExit -notin @(0,2)) { throw 'Preflight did not return supported diagnostics' }
$probe = (($raw -join [Environment]::NewLine) | ConvertFrom-Json)
$required = @(
    'CandidateNative','CandidateNativeFresh',
    'CandidateCompanion','CandidateCompanionFresh',
    'CandidateBrowserRuntimeCompatible','AdministrativelyElevated',
    'ScheduledServiceRunning','CanaryTaskKeyValid',
    'PrimaryAccountVerified','SecondaryAuthenticatedIdle',
    'DistinctBrowserProcesses','SameVerifiedAccount',
    'BothCompanionsGateEnabledAndMatching','SharedGateNotHeld'
)
foreach ($flag in $required) {
    if (-not $probe.Flags.$flag) { throw "Required installation safety gate failed: $flag" }
}
Write-Warning 'FORCE_MAINTENANCE will interrupt active Codexify worker/tool activity. Uncertain or accepted Sends must not be replayed.'

Write-Host '=== GUARDED IN-PLACE UPGRADE ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
    -Apply -ForceMaintenance -WaitForCanarySafe `
    -WaitTimeoutMinutes $WaitTimeoutMinutes `
    -PilotPrimaryTaskKey $primaryKey -CanaryTaskKey $canaryKey
AssertNativeExit 'Guarded two-browser installation'

$health = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 15
if ($health.StatusCode -ne 200) { throw 'Installed native service has not passed HTTP health' }
Write-Host 'UPGRADE_INSTALL_FINISHED_NATIVE_HTTP_200'
Write-Host 'Both goal receipts and actual browser concurrency still require post-install verification.'
