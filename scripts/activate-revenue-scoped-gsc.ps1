#Requires -RunAsAdministrator
# Single-shot, owner-confirmed activation of the prebuilt GSC-only worktree MCP lane.
# Preserves six canonical journals, seven ChatGPT schedules, tunnel credentials,
# the patched Codexify executable and all existing project permission denials.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'prepare-revenue-scoped-gsc.mjs'
$maintenance = Join-Path $env:USERPROFILE '.codexify\maintenance'
$sidecar = Join-Path $env:USERPROFILE '.codexify\revenue-shot-direct-v041'
$exe = Join-Path $env:USERPROFILE '.codexify\bin\codexify.exe'
$expectedExeSha = 'A07B471F1EAFEA87C6DE6C8CED4FF293284139080FB632866528C9A90B46CDC4'
$oldServerSha = '50A00D8F75C989B8F570176832FF6E3425C517D7F3FA8D06F7082EC8D4DFE5CB'
$oldConfigSha = '2DE7DA8D5F9B12D16B2C6932DC416A2D25B35E380273D790ECCFE271A1912EAF'
function Sha([string]$file) {
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}
function Healthy {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch {return $false}
}
function StopService {
  $task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  }
  for($n=0; $n -lt 55; $n++) {
    $proc = @(Get-CimInstance Win32_Process -Filter "name = 'codexify.exe'" -ErrorAction SilentlyContinue)
    $ports = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
    if ($proc.Count -eq 0 -and $ports.Count -eq 0) {return}
    Start-Sleep -Seconds 2
  }
  throw 'SERVICE_STOP_NOT_CONFIRMED'
}
function StartService {
  Start-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  for($n=0; $n -lt 105; $n++) {
    $t = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction SilentlyContinue
    if ($null -ne $t -and $t.State -eq 'Running' -and (Healthy)) {return}
    Start-Sleep -Seconds 2
  }
  throw 'SERVICE_RESTART_HEALTH_TIMEOUT'
}
if ((Sha $exe) -cne $expectedExeSha) {throw 'CODEXIFY_PATCH_SHA_MISMATCH_ABORT'}
$task = Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
if ($task.State -ne 'Running' -or !(Healthy)) {throw 'PRE_ACTIVATION_SERVICE_NOT_HEALTHY'}
$other = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
  $_.TaskName -like 'Codexify-Patch-*' -and $_.State -eq 'Running'
})
if ($other.Count -ne 0) {throw 'CONCURRENT_PATCH_RUNNING'}
if ((Sha (Join-Path $sidecar 'server.mjs')) -cne $oldServerSha) {throw 'SIDECAR_SERVER_BASELINE_CHANGED'}
if ((Sha (Join-Path $sidecar 'projects.json')) -cne $oldConfigSha) {throw 'SIDECAR_CONFIG_BASELINE_CHANGED'}
Write-Output 'GSC-only canary preflight: no changes'
& node $installer --check
if ($LASTEXITCODE -ne 0) {throw 'INSTALLER_DRY_RUN_FAILED'}
Write-Output 'Explicit owner approval required for GSC isolated source/tests. No generic journal writes.'
$env:REVENUE_ACTION_OWNER_APPROVAL = 'SCOPED_GSC_ONLY'
try {
  & node $installer --apply
  if ($LASTEXITCODE -ne 0) {throw 'OWNER_DID_NOT_APPROVE_OR_INSTALL_FAILED'}
} finally {
  Remove-Item Env:REVENUE_ACTION_OWNER_APPROVAL -ErrorAction SilentlyContinue
}
$receipts = @(Get-ChildItem -LiteralPath $maintenance -Directory -Filter 'scoped-gsc-backup-*' |
  Where-Object {$_.LastWriteTime -gt (Get-Date).AddMinutes(-10)} |
  Sort-Object LastWriteTime -Descending)
if ($receipts.Count -ne 1) {throw 'UNIQUE_INSTALL_RECEIPT_NOT_FOUND; DO_NOT_RESTART'}
$backup = $receipts[0].FullName
$receipt = Join-Path $backup 'installation-receipt.json'
if (!(Test-Path -LiteralPath $receipt)) {throw 'INSTALL_RECEIPT_MISSING; DO_NOT_RESTART'}
$expected = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json -ErrorAction Stop
if ((Sha (Join-Path $sidecar 'server.mjs')) -cne $expected.installed.server -or
    (Sha (Join-Path $sidecar 'projects.json')) -cne $expected.installed.config -or
    (Sha (Join-Path $sidecar 'scoped-worktree-actions.mjs')) -cne $expected.installed.helper) {
  throw 'POSTINSTALL_HASH_MISMATCH; DO_NOT_RESTART'
}
& node --check (Join-Path $sidecar 'server.mjs')
if ($LASTEXITCODE -ne 0) {throw 'SIDECAR_SYNTAX_FAILED; DO_NOT_RESTART'}
$attemptedStop = $false
try {
  $attemptedStop = $true
  StopService
  StartService
  Write-Output 'Codexify HTTP 200 after scoped GSC activation. Refresh God v5 tool catalog and verify 3 new actions.'
  Write-Output ('Receipt: ' + $receipt)
} catch {
  $failure = $_.Exception.Message
  Write-Warning ('Activation failed: ' + $failure)
  try {
    if ($attemptedStop) {StopService}
    $serverBackup = Join-Path $backup 'server.before.mjs'
    $configBackup = Join-Path $backup 'projects.before.json'
    if ((Sha $serverBackup) -cne $oldServerSha -or (Sha $configBackup) -cne $oldConfigSha) {
      throw 'ROLLBACK_BACKUP_HASH_MISMATCH'
    }
    Copy-Item -LiteralPath $serverBackup -Destination (Join-Path $sidecar 'server.mjs') -Force -ErrorAction Stop
    Copy-Item -LiteralPath $configBackup -Destination (Join-Path $sidecar 'projects.json') -Force -ErrorAction Stop
    # Preserve helper and evidence as forensic backups; disabled by restored config.
    if ((Sha (Join-Path $sidecar 'server.mjs')) -cne $oldServerSha -or
        (Sha (Join-Path $sidecar 'projects.json')) -cne $oldConfigSha) {
      throw 'ROLLBACK_HASH_MISMATCH'
    }
    StartService
    Write-Warning 'Original sidecar restored; Codexify HTTP 200.'
  } catch {
    Write-Warning ('ROLLBACK_FAILED: ' + $_.Exception.Message)
  }
  throw ('GSC_ACTIVATION_FAILED: ' + $failure)
}
