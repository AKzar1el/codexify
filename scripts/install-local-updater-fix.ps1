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
function VerifiedCodexifyListeners() {
    $result = @()
    foreach ($listener in @(Owners)) {
        $ownerId = [int]$listener.OwningProcess
        if ($ownerId -le 0) { throw 'A listener has no verifiable owning process' }
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ownerId) -ErrorAction Stop
        if (-not $process -or -not $process.ExecutablePath) {
            throw "Port $port has an unknown process owner; refusing to terminate it"
        }
        $samePath = [string]::Equals(
            [IO.Path]::GetFullPath([string]$process.ExecutablePath),
            [IO.Path]::GetFullPath($target),
            [StringComparison]::OrdinalIgnoreCase
        )
        if (-not $samePath -or [string]$process.CommandLine -notmatch '(?i)(--config|service\s+run)') {
            throw "Port $port owner $ownerId is not the verified Codexify service; refusing to terminate it"
        }
        $result += $ownerId
    }
    return $result
}
function WaitForOldListener() {
    for ($i=0; $i -lt 15; $i++) {
        if (@(Owners).Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    # The scheduled service is disabled by this point. It may have left behind
    # its child process, as seen on 11 November. Stop only the exact executable
    # and service command line that still own this particular local port.
    foreach ($ownerId in @(VerifiedCodexifyListeners)) {
        if (@(VerifiedCodexifyListeners) -notcontains $ownerId) { continue }
        Stop-Process -Id $ownerId -Force -ErrorAction Stop
        Report 'orphan_released' "Verified stopped-service orphan PID $ownerId was holding port $port"
    }
    for ($i=0; $i -lt 15; $i++) {
        if (@(Owners).Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw "Port $port remains occupied after verified old-service release; refusing to replace the executable"
}
function WaitForReady() {
    & $target service wait-ready --port $port --timeout-ms 120000
    CheckExit 'Service readiness'
}
function EnsureBrowserReady() {
    # The native service does not guarantee that its separate Electron browser
    # companion has finished account/session initialization. Do not mistake a
    # transient startup timeout for an installation failure.
    & $target browser start
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
            $result = ((& $target browser status --json 2>&1) -join [Environment]::NewLine) | ConvertFrom-Json
            if ($result.state -eq 'ready' -and $result.authenticated -and -not $result.activeActionId) {
                return
            }
        } catch {}
        Start-Sleep -Seconds 3
    }
    throw 'Browser companion did not become authenticated and ready after service restart'
}
function AssertFleetQuiet() {
    # This one-shot updater must not terminate the shared MCP service while
    # another Codexify conversation is actively executing tools. Read only
    # owner-chat activity; fail closed if the owner API is not reachable.
    $ownerFile = Join-Path $root 'owner-chat.json'
    if (-not (Test-Path -LiteralPath $ownerFile)) {
        throw 'Cannot confirm that the shared worker fleet is idle'
    }
    $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    if (-not $owner.token -or -not $owner.port) {
        throw 'Cannot verify owner-chat session for the idle check'
    }
    $url = 'http://127.0.0.1:' + $owner.port + '/api/chats'
    $auth = @{Authorization = 'Bearer ' + $owner.token}
    $all = Invoke-RestMethod -Uri $url -Headers $auth -TimeoutSec 12
    $cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 180000
    $active = @($all.chats | Where-Object {
        $_.workspace -ne 'codexify-reliability-lab' -and
        $_.lastAgentCallAtMs -and
        [double]$_.lastAgentCallAtMs -gt $cutoff
    })
    if ($active.Count -gt 0) {
        $names = (@($active | Select-Object -ExpandProperty workspace -Unique) -join ', ')
        throw "Other Codexify workers were active in the last three minutes: $names"
    }
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
    [IO.Path]::GetFullPath((Join-Path $root 'backups')) + [IO.Path]::DirectorySeparatorChar,
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
    AssertFleetQuiet
    Report 'stopping' 'Stopping only the existing Codexify service for the local updater repair'
    & $target browser stop-for-restart
    CheckExit 'Prepare browser for service restart'
    # Set this before running disable: Task Scheduler can stop the service
    # successfully but the command may still fail to return a receipt.
    # The catch handler must then attempt service recovery.
    $serviceStopped = $true
    & $target service disable
    CheckExit 'Stop scheduled service'
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
    EnsureBrowserReady
    Report 'service_healthy' 'Patched Codexify service and browser are running; original executable retained'
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
        try { & $target service enable; & $target service wait-ready --port $port --timeout-ms 120000; EnsureBrowserReady } catch {}
    } else {
        # The prior service is still running, but stop-for-restart might have
        # stopped the browser before the failure was detected.
        try { & $target browser start | Out-Null } catch {}
    }
    throw "Local updater repair installation failed: $reason. Backup: $backup"
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    }
}
