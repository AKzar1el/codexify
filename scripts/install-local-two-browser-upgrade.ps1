# Install a locally built, verified Codexify executable without downloading the
# Guarded local two-browser update: native executable, private browser runtime
# app.asar, and persisted Send-gate configuration in one rollback transaction.
# Must be started from a separate elevated PowerShell, never its own connector.
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$PreflightOnly,
    [switch]$VerifyMaintenanceOnly,
    [switch]$SelfTest,
    [string]$CanaryTaskKey = '',
    [string]$BackupDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$root = Join-Path $env:USERPROFILE '.codexify'
$target = Join-Path $root 'bin\codexify.exe'
$built = Join-Path $repo 'target\debug\codexify.exe'
$asar = Join-Path $root 'browser\runtime\2.3.29\app\resources\app.asar'
$builtAsar = Join-Path $repo 'browser-companion\release\win-unpacked\resources\app.asar'
$configFile = Join-Path $root 'codexify.config.json'
$lane2 = Join-Path $root 'browser-lane2-canary\descriptor.json'
$sharedGate = Join-Path $root 'browser-pool\send.lock'
$preflightScript = Join-Path $PSScriptRoot 'preflight-two-browser-rollout.ps1'
$port = 3000
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = if ($BackupDirectory) { $BackupDirectory } else { Join-Path $root "backups\two-browser-$runId" }
$previous = Join-Path $backup 'previous.exe'
$previousAsar = Join-Path $backup 'previous-app.asar'
$previousConfig = Join-Path $backup 'previous-config.json'
$failed = Join-Path $backup 'failed-patched.exe'
$failedAsar = Join-Path $backup 'failed-patched-app.asar'
$failedConfig = Join-Path $backup 'failed-patched-config.json'
$stage = Join-Path (Split-Path $target -Parent) ".codexify-two-browser-$runId.exe"
$asarStage = Join-Path (Split-Path $asar -Parent) ".codexify-two-browser-$runId.asar"
$configStage = Join-Path (Split-Path $configFile -Parent) ".codexify-two-browser-$runId.json"
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
function Preflight() {
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $arguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$preflightScript)
    if ($CanaryTaskKey) { $arguments += @('-CanaryTaskKey',$CanaryTaskKey) }
    $raw = & $powershellExe @arguments 2>&1
    if ($LASTEXITCODE -notin @(0,2)) {
        throw 'Read-only two-browser preflight did not produce a supported result'
    }
    return (($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop)
}
function AssertReadyForInstall($probe) {
    if (-not $probe.ReadyForGuardedMaintenance) {
        throw ('Installation gate is closed: ' + ($probe.InstallationBlockedBy -join ', '))
    }
    if ($CanaryTaskKey) {
        foreach ($name in @('CanaryTaskKeyValid','SecondaryAuthenticatedIdle','DistinctBrowserProcesses','SameVerifiedAccount')) {
            if (-not $probe.Flags.$name) {
                throw "Canary prerequisite is missing: $name"
            }
        }
    }
}
function AssertCanaryBelongsToPairedGoal([string]$key) {
    if (-not $key) { return }
    if ($key -notmatch '^[a-f0-9]{64}$') {
        throw 'Canary key must be one verified 64-character stable task identity'
    }
    $projects = Join-Path $root 'projects'
    $matches = @()
    foreach ($project in @(Get-ChildItem -LiteralPath $projects -Directory -ErrorAction Stop)) {
        if ($project.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $stateFile = Join-Path $project.FullName (Join-Path 'chats' (Join-Path $key 'automation.json'))
        if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
            $matches += $stateFile
        }
    }
    if ($matches.Count -ne 1) {
        throw 'Canary identity was not found in exactly one local project state'
    }
    $state = Get-Content -LiteralPath $matches[0] -Raw | ConvertFrom-Json
    if (-not $state.pairing.verifiedOwnerGeneration -or
        -not $state.pairing.canonicalUrl -or
        -not $state.pairing.accountFingerprint -or
        $state.goal.status -ne 'active' -or
        ($state.turnRenewal.handoff -and -not $state.turnRenewal.handoff.reportComplete)) {
        throw 'Canary is not a verified active goal with a reconciled renewal handoff'
    }
    if ($state.action.status -in @('ambiguous','rate_limited','interference','failed','navigating','sending','generating')) {
        throw 'Canary has an unresolved in-flight or delivery-failure action'
    }
}
function StageFile([string]$source,[string]$destination) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
        (Test-Path -LiteralPath $destination)) {
        throw 'Stage source is missing or a prior staging file already exists'
    }
    Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
        throw 'File staging checksum mismatch'
    }
}
function AssertInstalledMatchesBackup() {
    foreach ($pair in @(
        @($target,$previous),
        @($asar,$previousAsar),
        @($configFile,$previousConfig)
    )) {
        if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash) {
            throw 'A production file changed during staging; aborting without overwriting it'
        }
    }
}
function PrepareConfig([string]$destination) {
    $settings = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -ErrorAction Stop
    if (-not $settings.PSObject.Properties['agentChat'] -or
        -not $settings.agentChat.PSObject.Properties['automation']) {
        throw 'Missing agentChat.automation configuration'
    }
    $automation = $settings.agentChat.automation
    if ($automation.PSObject.Properties['canaryTaskKey'] -and
        $automation.canaryTaskKey -and
        $automation.canaryTaskKey -ne $CanaryTaskKey) {
        throw 'An existing canary key differs from the requested owner'
    }
    if (-not $CanaryTaskKey -and
        $automation.PSObject.Properties['lane2DescriptorPath'] -and
        $automation.lane2DescriptorPath) {
        throw 'A saved lane-2 descriptor requires its exact canary task key'
    }
    $automation | Add-Member -NotePropertyName providerSendGatePath -NotePropertyValue $sharedGate -Force
    if ($CanaryTaskKey) {
        $automation | Add-Member -NotePropertyName canaryTaskKey -NotePropertyValue $CanaryTaskKey -Force
        $automation | Add-Member -NotePropertyName lane2DescriptorPath -NotePropertyValue $lane2 -Force
    }
    $serialized = $settings | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($destination,$serialized,[Text.UTF8Encoding]::new($false))
    $check = Get-Content -LiteralPath $destination -Raw | ConvertFrom-Json
    if ($check.agentChat.automation.providerSendGatePath -ne $sharedGate -or
        ($CanaryTaskKey -and $check.agentChat.automation.canaryTaskKey -ne $CanaryTaskKey)) {
        throw 'Staged configuration did not preserve the exact gate and task identities'
    }
}
function AssertTaskAdministration() {
    # The Codexify scheduled task is owned by BUILTIN\Administrators. A
    # non-elevated user can query (and sometimes stop) the task but cannot
    # disable or re-enable it. Fail before stopping the browser or copying
    # anything instead of leaving the service partially stopped.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator PowerShell is required to control the Codexify scheduled task. Open PowerShell using Run as administrator and rerun the installer; nothing was stopped.'
    }
    # Updater must outlive the executable it replaces. An elevated child of
    # the running Codexify MCP process is not a safe independent installer.
    $ancestorId = $PID
    for ($i=0; $i -lt 12 -and $ancestorId -gt 0; $i++) {
        $ancestor = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ancestorId)
        if (-not $ancestor) { break }
        if ($ancestor.Name -ieq 'codexify.exe') {
            throw 'Launch the installer from an independent elevated PowerShell, not from the Codexify tool connection'
        }
        $ancestorId = [int]$ancestor.ParentProcessId
    }
    $task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
    if ($task.TaskPath -ne '\') {
        throw 'The expected Codexify scheduled task was not found at the root task path'
    }
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
function WaitForVerifiedServiceProcessesExit() {
    # Task Scheduler can stop the PowerShell supervisor without terminating
    # BOTH native Codexify service processes: "service run --config" and its
    # "--config" child. Release only those exact owned processes, after
    # disabling the scheduled task. Other Codexify CLI invocations are never
    # terminated just because they use the same binary.
    $config = Join-Path $root 'codexify.config.json'
    for ($attempt=0; $attempt -lt 10; $attempt++) {
        $live = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($live.Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    $verified = @()
    foreach ($process in $live) {
        $command = [string]$process.CommandLine
        $looksLikeService = ($command.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0) -and
            ($command -match '(?i)\bservice\s+run\s+--config\b' -or
             $command -match '(?i)\bcodexify\.exe"?\s+--config\b')
        if (-not $looksLikeService) {
            throw "Installed Codexify process PID $($process.ProcessId) is not a verified service process. Refusing to terminate it."
        }
        $verified += $process
    }
    foreach ($process in $verified) {
        $command = [string]$process.CommandLine
        $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$process.ProcessId) -ErrorAction Stop
        if (-not $current) { continue }
        if (-not [string]::Equals([string]$current.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase) -or
            [string]$current.CommandLine -ne $command) {
            throw "Service process PID $($process.ProcessId) changed during inspection. Refusing to terminate it."
        }
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        Report 'old_service_released' "Stopped verified orphaned Codexify service process PID $($process.ProcessId)"
    }
    for ($attempt=0; $attempt -lt 12; $attempt++) {
        $still = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($still.Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw 'The previously installed Codexify executable is still in use after service shutdown'
}
function WaitForReady() {
    & $target service wait-ready --port $port --timeout-ms 120000
    if ($LASTEXITCODE -eq 0) { return }
    # Native wait-ready can time out while Task Scheduler is still bringing the
    # replacement up. Do not immediately attempt a destructive rollback: first
    # independently verify the installed binary, supervised task, actual port
    # owner and HTTP health. If all are healthy, the update is successful.
    Write-Warning 'Codexify wait-ready timed out; performing independent bounded service verification before considering rollback.'
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        if (Test-InstalledServiceHealthy) {
            Write-Output 'SERVICE_READY_VERIFIED_AFTER_TIMEOUT'
            return
        }
        Start-Sleep -Seconds 2
    }
    throw 'Service readiness failed and independent native-service verification did not recover'
}
function Test-InstalledServiceHealthy() {
    try {
        $task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
        if ($task.State -ne 'Running' -or -not $task.Settings.Enabled) { return $false }
        $listeners = @(Owners)
        if ($listeners.Count -ne 1) { return $false }
        $ownerId = [int]$listeners[0].OwningProcess
        if ($ownerId -le 0) { return $false }
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ownerId) -ErrorAction Stop
        $config = Join-Path $root 'codexify.config.json'
        if (-not $process -or -not $process.ExecutablePath -or
            -not [string]::Equals([string]$process.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase) -or
            ([string]$process.CommandLine).IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            return $false
        }
        $health = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/health") -TimeoutSec 5 -ErrorAction Stop
        return $health.status -eq 'ok'
    } catch {
        return $false
    }
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
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $active = @($all.chats | Where-Object {
        $_.workspace -ne 'codexify-reliability-lab' -and (
            ($_.lastAgentCallAtMs -and [double]$_.lastAgentCallAtMs -gt $cutoff) -or
            ($_.agentPresenceUntilMs -and [double]$_.agentPresenceUntilMs -gt $now -and
                (-not $_.agentIdleUntilMs -or [double]$_.agentIdleUntilMs -le $now) -and
                (-not $_.agentWaitingUntilMs -or [double]$_.agentWaitingUntilMs -le $now))
        )
    })
    if ($active.Count -gt 0) {
        $names = (@($active | Select-Object -ExpandProperty workspace -Unique) -join ', ')
        throw "Other Codexify workers were active in the last three minutes: $names"
    }
}
function BrowserProof([string]$descriptorPath) {
    $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    $uri = [Uri]$descriptor.endpoint
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or
        -not (Get-Process -Id $descriptor.pid -ErrorAction SilentlyContinue)) {
        throw 'Companion is not an independent live localhost process'
    }
    $headers = @{Authorization=('Bearer ' + $descriptor.token)}
    $health = Invoke-RestMethod -Uri ($descriptor.endpoint + '/v1/health') -Headers $headers -TimeoutSec 12
    $gate = Invoke-RestMethod -Uri ($descriptor.endpoint + '/v1/send-gate/status') -Headers $headers -TimeoutSec 12
    # A newly enabled canary may already be generating when post-start
    # verification executes. Never mistake productive work for failed health
    # and restart a process that might have accepted a Send.
    if (-not $health.authenticated -or
        -not $gate.enabled -or $gate.pathFingerprint -notmatch '^[a-f0-9]{64}$') {
        throw 'Browser is not authenticated and protected by Send admission'
    }
    return [pscustomobject]@{
        pid=[int]$descriptor.pid
        account=$health.accountFingerprint
        gate=$gate.pathFingerprint
    }
}
function AssertTwoBrowsersGuarded() {
    $primary = BrowserProof (Join-Path $root 'browser\descriptor.json')
    $secondary = BrowserProof $lane2
    if ($primary.pid -eq $secondary.pid -or -not $primary.account -or
        $primary.account -ne $secondary.account -or $primary.gate -ne $secondary.gate) {
        throw 'Independent browser accounts or Send gate fingerprints do not match'
    }
}
function TestTransactionWithoutService {
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('codexify-two-browser-test-'+[Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $fixture -ErrorAction Stop)
    try {
        foreach ($part in @('native','browser','config')) {
            $old = Join-Path $fixture "$part.installed"
            $new = Join-Path $fixture "$part.candidate"
            [IO.File]::WriteAllText($old,"before-$part")
            [IO.File]::WriteAllText($new,"after-$part")
            StageFile $old (Join-Path $fixture "$part.backup")
            StageFile $new (Join-Path $fixture "$part.stage")
            [IO.File]::Replace((Join-Path $fixture "$part.stage"),$old,(Join-Path $fixture "$part.replaced"),$true)
            if ([IO.File]::ReadAllText($old) -ne "after-$part") {
                throw 'Atomic stage install failed in test fixture'
            }
        }
        foreach ($part in @('config','browser','native')) {
            $old = Join-Path $fixture "$part.installed"
            $backupFile = Join-Path $fixture "$part.backup"
            $restoreFile = Join-Path $fixture "$part.restore"
            StageFile $backupFile $restoreFile
            [IO.File]::Replace($restoreFile,$old,(Join-Path $fixture "$part.replaced-back"),$true)
            if ((Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash -ne
                (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash) {
                throw 'Rollback checksum mismatch in test fixture'
            }
        }
        $originalConfig = (Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash
        PrepareConfig (Join-Path $fixture 'preview.json')
        if ((Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash -ne $originalConfig) {
            throw 'Config preview unexpectedly changed the installed configuration'
        }
        $target = Join-Path $fixture 'native.installed'
        $previous = Join-Path $fixture 'native.backup'
        $asar = Join-Path $fixture 'browser.installed'
        $previousAsar = Join-Path $fixture 'browser.backup'
        $configFile = Join-Path $fixture 'config.installed'
        $previousConfig = Join-Path $fixture 'config.backup'
        AssertInstalledMatchesBackup
        [IO.File]::WriteAllText($configFile,'concurrent-change')
        $rejected = $false
        try { AssertInstalledMatchesBackup } catch { $rejected = $true }
        if (-not $rejected) { throw 'Concurrent production config change was not detected' }
        # Validate a real task-key shape and reject an unresolved action using
        # a disposable project state, not any production chat or accepted Send.
        $root = Join-Path $fixture 'fake-codexify-home'
        $testKey = 'b' * 64
        $testDir = Join-Path $root (Join-Path 'projects\fixture\chats' $testKey)
        [void](New-Item -ItemType Directory -Path $testDir -Force)
        $stateFile = Join-Path $testDir 'automation.json'
        $state = @{
            pairing = @{verifiedOwnerGeneration=1;canonicalUrl='https://chatgpt.com/c/fixture';accountFingerprint='fixture-account'}
            goal = @{status='active'}
            turnRenewal = @{handoff=$null}
            action = @{status='idle'}
        }
        [IO.File]::WriteAllText($stateFile,($state | ConvertTo-Json -Depth 8))
        AssertCanaryBelongsToPairedGoal $testKey
        $state.action.status = 'ambiguous'
        [IO.File]::WriteAllText($stateFile,($state | ConvertTo-Json -Depth 8))
        $rejected = $false
        try { AssertCanaryBelongsToPairedGoal $testKey } catch { $rejected = $true }
        if (-not $rejected) { throw 'Ambiguous accepted action was allowed as a canary' }
        Write-Output 'TEST_ATOMIC_NATIVE_BROWSER_CONFIG_AND_ROLLBACK=PASS'
    } finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if ($SelfTest) {
    if ($Apply -or $VerifyMaintenanceOnly -or $PreflightOnly) {
        throw 'SelfTest cannot be combined with deployment or preflight switches'
    }
    TestTransactionWithoutService
    return
}

foreach ($path in @($target,$built,$asar,$builtAsar,$configFile,$lane2)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path" }
}
$probe = Preflight
$hash = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
$asarHash = (Get-FileHash -LiteralPath $builtAsar -Algorithm SHA256).Hash
if ($PreflightOnly -or (-not $Apply -and -not $VerifyMaintenanceOnly)) {
    Write-Output (ConvertTo-Json ([ordered]@{
        ReadOnly = $true
        NativeCandidateFresh = $probe.Flags.CandidateNativeFresh
        BrowserCandidateFresh = $probe.Flags.CandidateCompanionFresh
        InstallationBlockedBy = @($probe.InstallationBlockedBy)
        ActivationBlockedBy = @($probe.ActivationBlockedBy)
        NativeCandidateSHA256 = $hash
        BrowserCandidateSHA256 = $asarHash
    }) -Depth 5)
    return
}
if ($VerifyMaintenanceOnly) {
    $browser = ((& $target browser status --json 2>&1) -join [Environment]::NewLine) | ConvertFrom-Json
    if ($browser.state -ne 'ready' -or -not $browser.authenticated -or $browser.activeActionId) {
        throw "Browser is not idle: $($browser.state)"
    }
    AssertFleetQuiet
    Write-Output "MAINTENANCE_CHECK_OK browser=$($browser.state) local_build=$hash"
    return
}
AssertTaskAdministration
AssertReadyForInstall $probe
AssertCanaryBelongsToPairedGoal $CanaryTaskKey
if ($CanaryTaskKey -and $CanaryTaskKey -notmatch '^[a-f0-9]{64}$') {
    throw 'Canary key must be the exact verified lowercase stable task key'
}
if (Test-Path -LiteralPath $sharedGate) {
    throw 'Shared Send admission lock exists: inspect the accepted action before maintenance'
}
$manifest = Get-Content -LiteralPath (Join-Path $root 'browser\runtime\2.3.29\manifest.json') -Raw | ConvertFrom-Json
if ($manifest.codexifyVersion -ne '2.3.29' -or $manifest.protocolVersion -ne 1) {
    throw 'Installed browser runtime protocol changed; refusing unverified replacement'
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
    StageFile $target $previous
    StageFile $asar $previousAsar
    StageFile $configFile $previousConfig
    StageFile $built $stage
    StageFile $builtAsar $asarStage
    PrepareConfig $configStage
    if ((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $hash -or
        (Get-FileHash -LiteralPath $asarStage -Algorithm SHA256).Hash -ne $asarHash) {
        throw 'Candidate changed after staging'
    }
    AssertInstalledMatchesBackup
    Report 'backed_up' 'Existing native binary, browser app.asar and configuration preserved'
    $browser = ((& $target browser status --json 2>&1) -join "`n") | ConvertFrom-Json
    if ($browser.state -ne 'ready' -or -not $browser.authenticated -or $browser.activeActionId) {
        throw "Browser is not idle: $($browser.state)"
    }
    AssertReadyForInstall (Preflight)
    Report 'stopping' 'Guarded update of native service, signed-in browser runtime and configuration'
    & $target browser stop-for-restart
    CheckExit 'Prepare browser for service restart'
    # Set this before running disable: Task Scheduler can stop the service
    # successfully but the command may still fail to return a receipt.
    # The catch handler must then attempt service recovery.
    $serviceStopped = $true
    & $target service disable
    CheckExit 'Stop scheduled service'
    WaitForOldListener
    WaitForVerifiedServiceProcessesExit
    AssertInstalledMatchesBackup
    $still = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and
        [string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($still.Count) { throw 'Installed executable still in use; refusing to replace it' }
    $replaced = $true
    [IO.File]::Replace($stage, $target, $failed, $true)
    [IO.File]::Replace($asarStage, $asar, $failedAsar, $true)
    [IO.File]::Replace($configStage, $configFile, $failedConfig, $true)
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash -or
        (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -ne $asarHash) {
        throw 'Installed native or browser checksum mismatch'
    }
    & $target service enable
    CheckExit 'Enable scheduled service'
    WaitForReady
    EnsureBrowserReady
    AssertTwoBrowsersGuarded
    Report 'service_healthy' ('Native service and two signed-in browsers verified with matching Send gates; canary_enabled='+[bool]$CanaryTaskKey)
} catch {
    $reason = $_.Exception.Message
    Report 'failed' $reason
    if ($replaced) {
        try {
            try { & $target browser stop-for-restart | Out-Null } catch {}
            & $target service disable
            WaitForOldListener
            WaitForVerifiedServiceProcessesExit
            $restoreConfig = Join-Path (Split-Path $configFile -Parent) ".codexify-restore-$runId.json"
            $restoreAsar = Join-Path (Split-Path $asar -Parent) ".codexify-restore-$runId.asar"
            $restoreBinary = Join-Path (Split-Path $target -Parent) ".codexify-restore-$runId.exe"
            StageFile $previousConfig $restoreConfig
            StageFile $previousAsar $restoreAsar
            StageFile $previous $restoreBinary
            [IO.File]::Replace($restoreConfig, $configFile, (Join-Path $backup 'failed-restore-config.json'), $true)
            [IO.File]::Replace($restoreAsar, $asar, (Join-Path $backup 'failed-restore-app.asar'), $true)
            [IO.File]::Replace($restoreBinary, $target, $failed, $true)
            foreach ($pair in @(@($previousConfig,$configFile),@($previousAsar,$asar),@($previous,$target))) {
                if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ne
                    (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash) {
                    throw 'Rollback file checksum did not match its backup'
                }
            }
            Report 'rolled_back' 'Original native binary, browser runtime and config restored'
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
    throw "Two-browser release installation failed: $reason. Backup: $backup"
} finally {
    foreach ($candidateStage in @($stage,$asarStage,$configStage)) {
        if (Test-Path -LiteralPath $candidateStage) {
            Remove-Item -LiteralPath $candidateStage -Force -ErrorAction SilentlyContinue
        }
    }
}
