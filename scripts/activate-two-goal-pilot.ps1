# Codexify native two-task, two-browser pilot activation.
# Default is read-only. -Apply -ForceMaintenance requires independent elevated
# Windows PowerShell, not the service's own MCP connection.
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$ForceMaintenance,
  [ValidateRange(1,120)][int]$WaitTimeoutMinutes = 20
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Join-Path $env:USERPROFILE '.codexify'
$statesRoot=Join-Path $root 'projects'
$installer=Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$required=[ordered]@{
  'Lane 1 primary browser continuity probe'='primary'
  'Lane 2 secondary browser continuity probe'='secondary'
}
$identified=@{}
foreach($f in @(Get-ChildItem -LiteralPath $statesRoot -Filter automation.json -File -Recurse -ErrorAction Stop)) {
  $s=Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
  foreach($title in $required.Keys){
    if (-not $s.PSObject.Properties['goal'] -or $null -eq $s.goal -or
        -not $s.goal.PSObject.Properties['markdown'] -or
        [string]$s.goal.markdown -notmatch [regex]::Escape($title)) { continue }
    if ($identified.ContainsKey($title)) { throw "Duplicate task claims pilot identity: $title" }
    $key=$f.Directory.Name
    if ($key -notmatch '^[a-f0-9]{64}$') { throw "Pilot has invalid stable task key: $title" }
    $handoff=$s.turnRenewal.handoff
    $paired=[bool]($s.pairing.verifiedOwnerGeneration -and $s.pairing.canonicalUrl -and $s.pairing.accountFingerprint)
    $safe=[bool]($paired -and $s.goal.status -eq 'active' -and
      (-not $handoff -or $handoff.reportComplete) -and
      ([string]$s.action.status -in @('idle','queued')) -and
      ([string]$s.action.status -ne 'queued' -or $s.action.sendAccepted -ne $true))
    $identified[$title]=[pscustomobject]@{key=$key;safe=$safe;paired=$paired;state=$s;modified=$f.LastWriteTime}
  }
}
foreach($title in $required.Keys){
  if (-not $identified.ContainsKey($title)) { Write-Output ('PILOT_NOT_CREATED '+$required[$title]) }
  else {$item=$identified[$title];Write-Output ('PILOT '+$required[$title]+' TASK_KEY='+$item.key+' PAIRED='+$item.paired+' SAFE='+$item.safe+' ACTION='+[string]$item.state.action.status)}
}
if ($identified.Count -ne 2 -or @($identified.Values | Where-Object {-not $_.safe}).Count -ne 0) {
  Write-Output 'PILOT_ACTIVATION_BLOCKED: exactly two independently paired, active, safe Codexify goals required; do not forge pairing or handoffs.'
  if ($Apply) { throw 'The two pilot goals are not both verified and safe. No installation was attempted.' }
  return
}
$primary=$identified['Lane 1 primary browser continuity probe'].key
$secondary=$identified['Lane 2 secondary browser continuity probe'].key
if ($primary -eq $secondary) { throw 'Two pilot roles resolved to the same task identity' }
Write-Output 'TWO_INDEPENDENT_PILOTS_VERIFIED'
if (-not $Apply) { Write-Output 'READ_ONLY_PILOT_ACTIVATION_PREFLIGHT_PASSED';return }
if (-not $ForceMaintenance) { throw '-Apply requires explicit -ForceMaintenance' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Open a separate Administrator PowerShell to activate the pilot'
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Apply -ForceMaintenance `
  -WaitForCanarySafe -WaitTimeoutMinutes $WaitTimeoutMinutes -PilotPrimaryTaskKey $primary -CanaryTaskKey $secondary
if ($LASTEXITCODE -ne 0) { throw 'Guarded native two-task pilot installer failed or refused an unsafe handoff' }
$config=Get-Content -LiteralPath (Join-Path $root 'codexify.config.json') -Raw | ConvertFrom-Json
if ($config.agentChat.automation.pilotPrimaryTaskKey -cne $primary -or
    $config.agentChat.automation.canaryTaskKey -cne $secondary) {
  throw 'Installed pilot configuration did not match both selected identities'
}
$health=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 15
if ($health.status -ne 'ok') { throw 'Native service did not pass post-install /health verification' }
Write-Output 'TWO_PILOT_TASK_KEYS_INSTALLED_NATIVE_SERVICE_HEALTHY'
Write-Output 'AWAIT_REAL_LANE_1_AND_LANE_2_EXECUTION_RECEIPTS_FOR_CONCURRENCY_PROOF'
