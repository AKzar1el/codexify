# Install a locally built, verified Codexify executable without downloading the
# public release or modifying the installed browser companion. This can run in
# a user's PowerShell window or a separately scheduled one-time Windows task;
# it must NOT run as a child of the Codexify service it is replacing.
[CmdletBinding()]
param(
    [switch]$PreflightOnly,
    [string]$BackupDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$root = Join-Path $env:USERPROFILE '.codexify'
$target = Join-Path $root 'bin\codexify.exe'
$built = Join-Path $repo 'target\release\codexify.exe'
$port = 3000
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = if ($BackupDirectory) { $BackupDirectory } else { Join-Path $root "backups\updater-fix-$runId" }
$previous = Join-Path $backup 'previous.exe'
$failed = Join-Path $backup 'failed-patched.exe'
$stage = Join-Path (Split-Path $target -Parent) ".codexify-local-patch-$runId.exe"
$log = Join-Path $backup 'install.log'
$status = Join-Path $backup 'install-status.json'

function Report([string]$state, [string]$detail) {
    $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -LiteralPath $log -Value "[$stamp] $state $detail"
    [ordered]@{state=$state;detail=$detail;time=$stamp} |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $status -Encoding UTF8
    Write-Output "$state $detail"
}
function CheckExit([string]$description) {
    if ($LASTEXITCODE -ne 0) { throw "$description failed (exit code $LASTEXITCODE)" }
}
function Owners() {
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        throw 'Cannot verify the service listener without Get-NetTCPConnection'
    }
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $port })
}
function WaitForOldListener() {
    for ($i=0; $i -lt 30; $i++) {
        if (@(Owners).Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw 'The old service still owns port 3000; refusing to overwrite an active executable'
}
function WaitForReady() {
    & $target service wait-ready --port $port --timeout-ms 120000
    CheckExit 'Service readiness'
}

foreach ($path in @($target,$built)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path" }
}
$sourceFiles = @('src/self_update.rs','src/global_settings_ui.js') |
    ForEach-Object { Get-Item -LiteralPath (Join-Path $repo $_) }
$latestEdit = ($sourceFiles | Measure-Object -Property LastWriteTime -Maximum).Maximum
if ((Get-Item -LiteralPath $built).LastWriteTime -lt $latestEdit) {
    throw 'Local release binary predates the updater fix. Build the release before installing.'
}
$branch = (git -C $repo branch --show-current).Trim()
if ($branch -ne 'fix/windows-update-orphan-and-stale-banner-20261112') {
    throw "Unexpected source branch $branch"
}
$hash = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($hash -eq $installedHash) {
    Write-Output 'ALREADY_INSTALLED_SOURCE_HASH_MATCH'
    return
}
if ($PreflightOnly) {
    Write-Output "PREFLIGHT_OK built=$hash installed=$installedHash"
    return
}
if (-not [IO.Path]::GetFullPath($backup).StartsWith(
    [IO.Path]::GetFullPath((Join-Path $root 'backups')) + '\',
    [StringComparison]::OrdinalIgnoreCase)) {
    throw 'BackupDirectory must be a unique directory below the Codexify backups root'
}
if (Test-Path -LiteralPath $backup) { throw "Refusing to overwrite backup $backup" }
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$replaced = $false
$serviceStopped = $false
try {
    Copy-Item -LiteralPath $target -Destination $previous -ErrorAction Stop
    Copy-Item -LiteralPath $built -Destination $stage -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $hash) {
        throw 'Staged binary checksum mismatch'
    }
    $browser = ((& $target browser status --json 2>&1) -join "`n") | ConvertFrom-Json
    if ($browser.state -ne 'ready' -or $browser.activeActionId) {
        throw "Browser is not idle: $($browser.state)"
    }
    Report 'stopping' 'Stopping only the existing Codexify service for the local updater repair'
    & $target browser stop-for-restart
    CheckExit 'Prepare browser for service restart'
    & $target service disable
    CheckExit 'Stop scheduled service'
    $serviceStopped = $true
    WaitForOldListener
    $still = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and
        [string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($still.Count) { throw 'Installed executable still in use; refusing to replace it' }
    [IO.File]::Replace($stage, $target, $failed, $true)
    $replaced = $true
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) {
        throw 'Installed binary checksum mismatch'
    }
    & $target service enable
    CheckExit 'Enable scheduled service'
    WaitForReady
    Report 'service_healthy' 'Patched Codexify service is running; original executable retained'
} catch {
    $reason = $_.Exception.Message
    Report 'failed' $reason
    if ($replaced) {
        try {
            & $target service disable
            WaitForOldListener
            $restore = Join-Path $backup 'restore-staged.exe'
            Copy-Item -LiteralPath $previous -Destination $restore -ErrorAction Stop
            [IO.File]::Replace($restore, $target, $failed, $true)
            Report 'rolled_back' 'Restored prior executable from verified backup'
        } catch {
            Report 'rollback_blocked' $_.Exception.Message
        }
    }
    if ($serviceStopped) {
        try { & $target service enable; & $target service wait-ready --port $port --timeout-ms 120000 } catch {}
    }
    throw "Local updater repair installation failed: $reason. Backup: $backup"
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    }
}
