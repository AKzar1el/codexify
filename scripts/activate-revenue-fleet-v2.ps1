#Requires -RunAsAdministrator
# Owner-approved, single-service Revenue Shot v2 upgrade.
# Preserves Codexify binary, seven ChatGPT schedules, canonical journals,
# remote Git authority, and original sidecar backups.
$ErrorActionPreference = 'Stop'
$homeRoot = $env:USERPROFILE
$installer = Join-Path $PSScriptRoot 'prepare-revenue-fleet-v2.mjs'
$verifier = Join-Path $PSScriptRoot 'verify-revenue-fleet-v2.mjs'
$side = Join-Path $homeRoot '.codexify\revenue-shot-direct-v041'
$exe = Join-Path $homeRoot '.codexify\bin\codexify.exe'
$maintenance = Join-Path $homeRoot '.codexify\maintenance'
$original = @{
  server = '8E2FF4F7880B2107488A1CCC45CD31A06AAFC9756B64F18DCCEF40B38FE9E8C7'
  config = '7DEB19859D8A0A1B1048983D13318F8B16BB45EFBE96A692BE3926CFD04C5903'
  coding = 'DAA61919C805C3299B3E2605C5861EF4469DB4AAF3E820E573061676418897E8'
  helper = '095A30433320A38C59981F4BC9CEA73BD54F8D63990D6C65C12DDCD9EBF7B36A'
}
$files = @{
  server = 'server.mjs'
  config = 'projects.json'
  coding = 'coding.mjs'
  helper = 'fleet-scoped-worktree-actions.mjs'
}
function Sha([string]$p) {
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}
function Healthy {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($r.StatusCode -ne 200) { return $false }
    $h = $r.Content | ConvertFrom-Json -ErrorAction Stop
    return $h.upstreams.revenue_shot_preflight.state -eq 'connected'
  } catch { return $false }
}
function StopService {
  $task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop }
  for ($i=0; $i -lt 50; $i++) {
    $task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
    $proc = @(Get-CimInstance Win32_Process -Filter "name = 'codexify.exe'" -ErrorAction SilentlyContinue)
    $listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
    if ($task.State -ne 'Running' -and $proc.Count -eq 0 -and $listeners.Count -eq 0) { return }
    Start-Sleep -Seconds 2
  }
  throw 'CODEXIFY_STOP_NOT_VERIFIED'
}
function StartService {
  Start-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  for ($i=0; $i -lt 95; $i++) {
    $task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
    if ($task.State -eq 'Running' -and (Healthy)) { return }
    Start-Sleep -Seconds 2
  }
  throw 'CODEXIFY_RESTART_HEALTH_FAILED'
}
if (!(Test-Path -LiteralPath $exe)) { throw 'CODEXIFY_EXECUTABLE_MISSING' }
if ((Sha $exe) -cne 'A07B471F1EAFEA87C6DE6C8CED4FF293284139080FB632866528C9A90B46CDC4') {
  throw 'CODEXIFY_EXECUTABLE_PATCH_CHANGED'
}
foreach ($key in @('server','config','coding','helper')) {
  $file = Join-Path $side $files[$key]
  if ((Sha $file) -cne $original[$key]) { throw ('UNEXPECTED_BASELINE_'+$key) }
}
$conf = Get-Content (Join-Path $homeRoot '.codexify\codexify.config.json') -Raw |
  ConvertFrom-Json -ErrorAction Stop
if (@($conf.mcpServers.revenue_shot_preflight.tools).Count -ne 13) {
  throw 'DIRECT_MCP_ACTION_ALLOWLIST_NOT_13'
}
if ((Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop).State -ne 'Running' -or !(Healthy)) {
  throw 'SERVICE_NOT_HEALTHY_BEFORE_CHANGE'
}
$patches = @(Get-ScheduledTask | Where-Object {
  $_.TaskName -like 'Codexify-Patch-*' -and $_.State -eq 'Running'
})
if ($patches.Count -gt 0) { throw 'CONCURRENT_CODEXIFY_PATCH' }
Write-Output 'Verifying a four-file reader/unit-test update without changing the live service.'
& node $installer --check
if ($LASTEXITCODE -ne 0) { throw 'FLEET_V2_DRYRUN_FAILED' }
foreach ($p in @('fleet-coding-reader-v2.mjs','fleet-scoped-worktree-actions.mjs',
    'prepare-revenue-fleet-v2.mjs','verify-revenue-fleet-v2.mjs')) {
  & node --check (Join-Path $PSScriptRoot $p)
  if ($LASTEXITCODE -ne 0) { throw ('NODE_SYNTAX_FAILED_'+$p) }
}
$env:REVENUE_ACTION_OWNER_APPROVAL = 'REVENUE_FLEET_V2'
$started = Get-Date
try {
  & node $installer --apply
  if ($LASTEXITCODE -ne 0) { throw 'OWNER_DECLINED_OR_INSTALL_FAILED' }
} finally {
  Remove-Item Env:REVENUE_ACTION_OWNER_APPROVAL -ErrorAction SilentlyContinue
}
$candidates = @(Get-ChildItem -LiteralPath $maintenance -Directory -Filter 'fleet-v2-backup-*' |
  Where-Object {$_.LastWriteTime -gt $started.AddMinutes(-1)})
if ($candidates.Count -ne 1) {
  throw 'UNIQUE_BACKUP_RECEIPT_NOT_FOUND_DO_NOT_RESTART'
}
$backup = $candidates[0].FullName
$receiptFile = Join-Path $backup 'installation-receipt.json'
if (!(Test-Path -LiteralPath $receiptFile)) { throw 'INSTALLATION_RECEIPT_MISSING' }
$receipt = Get-Content $receiptFile -Raw | ConvertFrom-Json -ErrorAction Stop
$startAttempted = $false
try {
  foreach ($key in @('server','config','coding','helper')) {
    if ((Sha (Join-Path $side $files[$key])) -cne $receipt.newHashes.$key) {
      throw ('INSTALLED_HASH_NOT_VERIFIED_'+$key)
    }
    if ((Sha (Join-Path $backup ($key+'.before'))) -cne $original[$key]) {
      throw ('ORIGINAL_BACKUP_HASH_NOT_VERIFIED_'+$key)
    }
  }
  foreach ($name in @('server.mjs','coding.mjs','fleet-scoped-worktree-actions.mjs')) {
    & node --check (Join-Path $side $name)
    if ($LASTEXITCODE -ne 0) { throw ('LIVE_NODE_SYNTAX_ERROR_'+$name) }
  }
  & node $verifier
  if ($LASTEXITCODE -ne 0) { throw 'LIVE_MCP_READER_AND_SCHEMA_CHECK_FAILED' }
  $startAttempted = $true
  StopService
  StartService
  & node $verifier
  if ($LASTEXITCODE -ne 0) { throw 'POSTRESTART_READER_VERIFY_FAILED' }
  Write-Output 'SUCCESS: FLEET_V2_READER_AND_PROJECT_UNIT_CHECKS_HTTP200'
  Write-Output ('BACKUP_RECEIPT '+$receiptFile)
  Write-Output 'Refresh God v5 action definitions to expose check_id=project-unit.'
} catch {
  $failure = $_.Exception.Message
  Write-Warning ('Reader/unit upgrade failed: '+$failure)
  try {
    if ($startAttempted) { StopService }
    foreach ($key in @('server','config','coding','helper')) {
      $before = Join-Path $backup ($key+'.before')
      if ((Sha $before) -cne $original[$key]) { throw ('INVALID_BACKUP_'+$key) }
      Copy-Item -LiteralPath $before -Destination (Join-Path $side $files[$key]) -Force -ErrorAction Stop
      if ((Sha (Join-Path $side $files[$key])) -cne $original[$key]) {
        throw ('RESTORED_FILE_HASH_INVALID_'+$key)
      }
    }
    if ($startAttempted) { StartService }
    Write-Warning 'Restored the original four files; backup and forensic receipts preserved.'
  } catch { Write-Warning ('ROLLBACK_UNVERIFIED: '+$_.Exception.Message) }
  throw ('FLEET_V2_ACTIVATION_FAILED: '+$failure)
}
