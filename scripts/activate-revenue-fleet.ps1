#Requires -RunAsAdministrator
# Owner-reviewed rollout of the six-project isolated-worktree MCP action lane.
# No canonical repo edits or ChatGPT automation changes.
$ErrorActionPreference = 'Stop'
$checkout = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'prepare-revenue-fleet.mjs'
$verify = Join-Path $PSScriptRoot 'verify-installed-fleet.mjs'
$side = Join-Path $env:USERPROFILE '.codexify\revenue-shot-direct-v041'
$maint = Join-Path $env:USERPROFILE '.codexify\maintenance'
$exe = Join-Path $env:USERPROFILE '.codexify\bin\codexify.exe'
$expectedExe = 'A07B471F1EAFEA87C6DE6C8CED4FF293284139080FB632866528C9A90B46CDC4'
$expectedServer = '0B88C17B120EE1729BC14CC80352D39DA416E30C9D3D378D7DA8639B8764FCEB'
$expectedConfig = '88054B42440AC01FF05116BE667D89C64172F703FC9F3EFD2AE28836A095E744'
function Sha([string]$file) {
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}
function Healthy {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch {return $false}
}
function StopService {
  $t = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  if ($t.State -eq 'Running') {Stop-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop}
  for($i=0;$i -lt 65;$i++){
    $procs = @(Get-CimInstance Win32_Process -Filter "name = 'codexify.exe'" -ErrorAction SilentlyContinue)
    $listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
    if($procs.Count -eq 0 -and $listeners.Count -eq 0){return}
    Start-Sleep -Seconds 2
  }
  throw 'CODEXIFY_STOP_TIMEOUT'
}
function StartService {
  Start-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  for($i=0;$i -lt 120;$i++){
    $t = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction SilentlyContinue
    if($t -and $t.State -eq 'Running' -and (Healthy)){return}
    Start-Sleep -Seconds 2
  }
  throw 'CODEXIFY_START_TIMEOUT'
}
if ((Sha $exe) -cne $expectedExe) {throw 'CODEXIFY_PATCH_CHANGED_ABORT'}
if ((Sha (Join-Path $side 'server.mjs')) -cne $expectedServer) {throw 'SIDECAR_SERVER_CHANGED_ABORT'}
if ((Sha (Join-Path $side 'projects.json')) -cne $expectedConfig) {throw 'SIDECAR_CONFIG_CHANGED_ABORT'}
$t = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
if ($t.State -ne 'Running' -or !(Healthy)) {throw 'PREDEPLOY_SERVICE_NOT_HEALTHY'}
$runningPatch = @(Get-ScheduledTask | Where-Object {
  $_.TaskName -like 'Codexify-Patch-*' -and $_.State -eq 'Running'
})
if ($runningPatch.Count -gt 0){throw 'CONCURRENT_CODEXIFY_PATCH_TASK'}
Write-Output 'Checking GSC canary baseline and six-project tool plan.'
& node $installer --check
if($LASTEXITCODE -ne 0){throw 'FLEET_DRY_RUN_FAILED'}
Write-Output 'This changes only Codexify MCP action definitions. It does not create any worktree or edit a project.'
Write-Output 'New write operations still require normal ChatGPT approval.'
$env:REVENUE_ACTION_OWNER_APPROVAL='SCOPED_FLEET_V1'
$started=Get-Date
try{
  & node $installer --apply
  if($LASTEXITCODE -ne 0){throw 'OWNER_REJECTED_OR_INSTALLER_FAILED'}
} finally{
  Remove-Item Env:REVENUE_ACTION_OWNER_APPROVAL -ErrorAction SilentlyContinue
}
$backups = @(Get-ChildItem -LiteralPath $maint -Directory -Filter 'fleet-scoped-backup-*' |
  Where-Object{$_.LastWriteTime -gt $started.AddMinutes(-1)} |
  Sort-Object LastWriteTime -Descending)
if($backups.Count -ne 1){throw 'UNIQUE_ROLLBACK_BACKUP_NOT_FOUND; DO_NOT_RESTART'}
$receiptFile=Join-Path $backups[0].FullName 'installation-receipt.json'
if(!(Test-Path -LiteralPath $receiptFile)){throw 'INSTALL_RECEIPT_MISSING; DO_NOT_RESTART'}
$receipt=Get-Content -LiteralPath $receiptFile -Raw|ConvertFrom-Json -ErrorAction Stop
foreach($spec in @(
 @{file='server.mjs';value=$receipt.sha.server},
 @{file='projects.json';value=$receipt.sha.config},
 @{file='fleet-scoped-worktree-actions.mjs';value=$receipt.sha.fleetHelper},
 @{file='fleet-worktree-init.mjs';value=$receipt.sha.initHelper}
)){
 if((Sha (Join-Path $side $spec.file)) -cne $spec.value){
   throw ('INSTALLED_HASH_MISMATCH: '+$spec.file+'; DO_NOT_RESTART')
 }
}
foreach($f in @('server.mjs','fleet-scoped-worktree-actions.mjs','fleet-worktree-init.mjs')){
 & node --check (Join-Path $side $f)
 if($LASTEXITCODE -ne 0){throw ('NODE_SYNTAX_FAILED '+$f+'; DO_NOT_RESTART')}
}
& node $verify
if($LASTEXITCODE -ne 0){throw 'LOCAL_TOOLS_LIST_NOT_VERIFIED; DO_NOT_RESTART'}
$attemptedStop=$false
try {
  $attemptedStop=$true
  StopService
  StartService
  & node $verify
  if($LASTEXITCODE -ne 0){throw 'POSTRESTART_FLEET_CATALOG_FAILED'}
  Write-Output 'FLEET_INSTALLED_HTTP200_AND_TOOL_LIST_VERIFIED'
  Write-Output ('BACKUP_RECEIPT '+$receiptFile)
  Write-Output 'Next: Workspace Apps > God v5 > Action control > Refresh, then enable reviewed new actions.'
} catch {
  $failure=$_.Exception.Message
  Write-Warning ('Activation problem: '+$failure)
  try {
    if($attemptedStop){StopService}
    $oldServer=Join-Path $backups[0].FullName 'server.before.mjs'
    $oldConfig=Join-Path $backups[0].FullName 'projects.before.json'
    if((Sha $oldServer) -cne $expectedServer -or (Sha $oldConfig) -cne $expectedConfig){
      throw 'UNTRUSTED_BACKUP'
    }
    Copy-Item -LiteralPath $oldServer -Destination (Join-Path $side 'server.mjs') -Force -ErrorAction Stop
    Copy-Item -LiteralPath $oldConfig -Destination (Join-Path $side 'projects.json') -Force -ErrorAction Stop
    if((Sha (Join-Path $side 'server.mjs')) -cne $expectedServer -or
       (Sha (Join-Path $side 'projects.json')) -cne $expectedConfig){
      throw 'ROLLBACK_HASH_ERROR'
    }
    StartService
    Write-Warning 'Original GSC-only sidecar restored with HTTP 200. Extra fleet helper files retained but inactive.'
  } catch {
    Write-Warning ('ROLLBACK_NOT_VERIFIED: '+$_.Exception.Message)
  }
  throw ('FLEET_ACTIVATION_FAILED: '+$failure)
}
