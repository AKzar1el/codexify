# Read-only two-browser deployment gate. Never restarts services or sends ChatGPT messages.
[CmdletBinding()]
param(
  [string]$CanaryTaskKey = '',
  [string]$CandidateBinary = '',
  [string]$CandidateCompanion = '',
  [int]$QuietMinutes = 3
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$homeDir = Join-Path $env:USERPROFILE '.codexify'
if (-not $CandidateBinary) { $CandidateBinary = Join-Path $repo 'target\debug\codexify.exe' }
if (-not $CandidateCompanion) {
  $CandidateCompanion = Join-Path $repo 'browser-companion\release\win-unpacked'
}
$primaryDescriptor = Join-Path $homeDir 'browser\descriptor.json'
$secondDescriptor = Join-Path $homeDir 'browser-lane2-canary\descriptor.json'
$sharedGate = Join-Path $homeDir 'browser-pool\send.lock'

function Get-CompanionState([string]$descriptor) {
  if (-not (Test-Path -LiteralPath $descriptor -PathType Leaf)) { return $null }
  $d = Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
  if (-not $d.pid -or -not $d.endpoint -or -not $d.token) { return $null }
  $u = [Uri]$d.endpoint
  if ($u.Scheme -ne 'http' -or $u.Host -ne '127.0.0.1') { return $null }
  if (-not (Get-Process -Id $d.pid -ErrorAction SilentlyContinue)) { return $null }
  $auth = @{ Authorization = 'Bearer ' + $d.token }
  $health = Invoke-RestMethod -Uri ($d.endpoint + '/v1/health') -Headers $auth -TimeoutSec 12
  $gate = $null
  try { $gate = Invoke-RestMethod -Uri ($d.endpoint + '/v1/send-gate/status') -Headers $auth -TimeoutSec 10 } catch {}
  return [pscustomobject]@{
    Pid = [int]$d.pid
    Build = [string]$d.build
    Status = [string]$health.status
    Auth = [bool]$health.authenticated
    Idle = ($health.status -eq 'idle' -and -not $health.activeActionId)
    Busy = ($health.status -eq 'busy' -or [bool]$health.activeActionId)
    Account = [string]$health.accountFingerprint
    Gate = $gate
  }
}

function Get-SecondaryStateForInstall([string]$descriptor,[bool]$required) {
  # The second companion is not on the execution path when no canary is
  # configured. A stale/offline lane-2 descriptor must not prevent the
  # primary-only guarded upgrade, but enabling lane 2 still requires proof.
  try { return Get-CompanionState $descriptor } catch {
    if ($required) { throw }
    return $null
  }
}

function Check-FleetQuiet([int]$minutes) {
  $ownerFile = Join-Path $homeDir 'owner-chat.json'
  if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf)) { return $false }
  $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
  $uri = 'http://127.0.0.1:' + [int]$owner.port + '/api/chats'
  $list = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = 'Bearer ' + $owner.token } -TimeoutSec 15
  $cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ($minutes * 60000)
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $active = @($list.chats | Where-Object {
    $_.workspace -ne 'codexify-reliability-lab' -and (
      ($_.lastAgentCallAtMs -and [double]$_.lastAgentCallAtMs -gt $cutoff) -or
      ($_.agentPresenceUntilMs -and [double]$_.agentPresenceUntilMs -gt $now -and
        (-not $_.agentIdleUntilMs -or [double]$_.agentIdleUntilMs -le $now) -and
        (-not $_.agentWaitingUntilMs -or [double]$_.agentWaitingUntilMs -le $now))
    )
  })
  return ($active.Count -eq 0)
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$installed = Join-Path $homeDir 'bin\codexify.exe'
$configFile = Join-Path $homeDir 'codexify.config.json'
if (-not $CanaryTaskKey -and (Test-Path -LiteralPath $configFile -PathType Leaf)) {
  $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
  if ($config.PSObject.Properties['agentChat'] -and
      $config.agentChat.PSObject.Properties['automation'] -and
      $config.agentChat.automation.PSObject.Properties['canaryTaskKey'] -and
      $config.agentChat.automation.canaryTaskKey) {
    $CanaryTaskKey = [string]$config.agentChat.automation.canaryTaskKey
  }
}
$exeCandidate = Test-Path -LiteralPath $CandidateBinary -PathType Leaf
$packagedExecutable = Join-Path $CandidateCompanion 'codexify-browser-companion.exe'
$packagedChrome = Join-Path $CandidateCompanion 'resources\chrome\chrome-executable.json'
$packageReady = (Test-Path -LiteralPath $packagedExecutable -PathType Leaf) -and
                (Test-Path -LiteralPath $packagedChrome -PathType Leaf)
$rustSources = @(Get-ChildItem -LiteralPath (Join-Path $repo 'src') -Recurse -File -Filter '*.rs')
$rustSources += Get-Item -LiteralPath (Join-Path $repo 'Cargo.toml')
$mostRecentRust = ($rustSources | Measure-Object -Property LastWriteTime -Maximum).Maximum
$nativeFresh = $exeCandidate -and (Get-Item -LiteralPath $CandidateBinary).LastWriteTime -ge $mostRecentRust
$companionBundle = Join-Path $CandidateCompanion 'resources\app.asar'
$browserSources = @(Get-ChildItem -LiteralPath (Join-Path $repo 'browser-companion\src') -Recurse -File -Filter '*.ts')
$newestBrowserSource = ($browserSources | Measure-Object -Property LastWriteTime -Maximum).Maximum
$companionFresh = $packageReady -and (Test-Path -LiteralPath $companionBundle -PathType Leaf) -and
  (Get-Item -LiteralPath $companionBundle).LastWriteTime -ge $newestBrowserSource
# This installer deliberately preserves the signed-in Electron executable
# and Chrome profile, replacing only app.asar. Refuse the swap if the new
# package expects different Electron support files from the installed runtime.
$installedApp = Join-Path $homeDir 'browser\runtime\2.3.29\app'
$installedSupport = if (Test-Path -LiteralPath $installedApp -PathType Container) {
  @(Get-ChildItem -LiteralPath $installedApp -File | Where-Object {
    $_.Name -ne 'codexify-browser-companion.exe'
  })
} else { @() }
$candidateSupport = if (Test-Path -LiteralPath $CandidateCompanion -PathType Container) {
  @(Get-ChildItem -LiteralPath $CandidateCompanion -File | Where-Object {
    $_.Name -ne 'codexify-browser-companion.exe'
  })
} else { @() }
$runtimeCompatible = $packageReady -and $installedSupport.Count -gt 0 -and
  $installedSupport.Count -eq $candidateSupport.Count
if ($runtimeCompatible) {
  foreach ($f in $installedSupport) {
    $other = Join-Path $CandidateCompanion $f.Name
    if (-not (Test-Path -LiteralPath $other -PathType Leaf) -or
        (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash) {
      $runtimeCompatible = $false
      break
    }
  }
}
$canaryKeyValid = ($CanaryTaskKey -match '^[a-f0-9]{64}$')

$primaryProbeError = $false
try { $primary = Get-CompanionState $primaryDescriptor } catch {
  # A companion restart may rotate its loopback endpoint/descriptor during
  # a read-only preflight. Treat failed health as UNKNOWN, not idle/allowed;
  # the installer can only wait for verified recovery, never install on it.
  $primary = $null
  $primaryProbeError = $true
}
$primaryBrowserStatus = if ($primary) { $primary.Status }
  elseif ($primaryProbeError) { 'probe_unavailable' }
  else { 'companion_missing' }
$lane2 = Get-SecondaryStateForInstall $secondDescriptor ([bool]$CanaryTaskKey)

$sameAccount = [bool]($primary -and $lane2 -and $primary.Auth -and $lane2.Auth -and
  $primary.Account -and $primary.Account -eq $lane2.Account)
$separateProcesses = [bool]($primary -and $lane2 -and $primary.Pid -ne $lane2.Pid)
$primaryGate = [bool]($primary -and $primary.Gate -and $primary.Gate.enabled)
$lane2Gate = [bool]($lane2 -and $lane2.Gate -and $lane2.Gate.enabled)
$sameGate = [bool]($primaryGate -and $lane2Gate -and
  $primary.Gate.pathFingerprint -eq $lane2.Gate.pathFingerprint)
$quiet = $false
$fleetVerified = $false
try {
  if (-not (Test-Path -LiteralPath (Join-Path $homeDir 'owner-chat.json') -PathType Leaf)) {
    throw 'Owner-chat status file is missing'
  }
  $quiet = Check-FleetQuiet $QuietMinutes
  $fleetVerified = $true
} catch {}
$task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction SilentlyContinue

$flags = [ordered]@{
  CandidateNative = [bool]$exeCandidate
  CandidateNativeFresh = [bool]$nativeFresh
  CandidateCompanion = [bool]$packageReady
  CandidateCompanionFresh = [bool]$companionFresh
  CandidateBrowserRuntimeCompatible = [bool]$runtimeCompatible
  AdministrativelyElevated = [bool]$isAdmin
  ScheduledServiceRunning = [bool]($task -and $task.State -eq 'Running')
  CanaryTaskKeyValid = [bool]$canaryKeyValid
  PrimaryAuthenticatedIdle = [bool]($primary -and $primary.Auth -and $primary.Account -and $primary.Idle)
  PrimaryAccountVerified = [bool]($primary -and $primary.Auth -and $primary.Account)
  PrimaryAuthenticatedBusy = [bool]($primary -and $primary.Auth -and $primary.Account -and $primary.Busy -and -not $primary.Idle)
  PrimaryAuthenticatedUnavailable = [bool]($primary -and $primary.Auth -and $primary.Account -and $primary.Status -eq 'unavailable')
  PrimaryAuthenticationRequired = [bool]($primary -and $primary.Status -eq 'authentication_required')
  SecondaryAuthenticatedIdle = [bool]($lane2 -and $lane2.Auth -and $lane2.Idle)
  DistinctBrowserProcesses = $separateProcesses
  SameVerifiedAccount = $sameAccount
  BothCompanionsGateEnabledAndMatching = $sameGate
  FleetQuiet = $quiet
  FleetStatusVerified = $fleetVerified
  SharedGateNotHeld = -not (Test-Path -LiteralPath $sharedGate)
}
# Installing the candidate necessarily precedes enabling the primary gate.
# Requiring both companions' new gate before upgrading the old primary would
# make this preflight impossible to satisfy. Keep the two gates separate.
$installChecks = @(
  'CandidateNative', 'CandidateNativeFresh',
  'CandidateCompanion', 'CandidateCompanionFresh',
  'CandidateBrowserRuntimeCompatible', 'AdministrativelyElevated',
  'ScheduledServiceRunning', 'PrimaryAuthenticatedIdle', 'FleetQuiet',
  'SharedGateNotHeld'
)
$activationChecks = @(
  'CanaryTaskKeyValid', 'SecondaryAuthenticatedIdle',
  'DistinctBrowserProcesses', 'SameVerifiedAccount',
  'BothCompanionsGateEnabledAndMatching'
)
$maintenanceReady = -not (@($installChecks | Where-Object { -not $flags[$_] }).Count -gt 0)
$activationReady = $maintenanceReady -and
  -not (@($activationChecks | Where-Object { -not $flags[$_] }).Count -gt 0)
$result = [ordered]@{
  ReadOnly = $true
  PrimaryBrowserStatus = $primaryBrowserStatus
  ReadyForGuardedMaintenance = $maintenanceReady
  ReadyToActivateTwoLanes = $activationReady
  InstallationBlockedBy = @($installChecks | Where-Object { -not $flags[$_] })
  ActivationBlockedBy = @($activationChecks | Where-Object { -not $flags[$_] })
  Flags = $flags
  NativeCandidateSHA256 = if ($exeCandidate) { (Get-FileHash -LiteralPath $CandidateBinary -Algorithm SHA256).Hash } else { $null }
  InstalledBinarySHA256 = if (Test-Path -LiteralPath $installed) { (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash } else { $null }
}
$result | ConvertTo-Json -Depth 5
if (-not $activationReady) { exit 2 }
