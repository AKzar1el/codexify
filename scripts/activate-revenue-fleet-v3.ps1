#Requires -RunAsAdministrator
# One-time owner-approved v3 sidecar upgrade. Does not alter canonical repos,
# historical journal/state, saved cloud schedules, or any remote Git ref.
$ErrorActionPreference='Stop'
$root=Join-Path $env:USERPROFILE '.codexify'
$side=Join-Path $root 'revenue-shot-direct-v041'
$binary=Join-Path $root 'bin\codexify.exe'
$installer=Join-Path $PSScriptRoot 'prepare-revenue-fleet-v3.mjs'
$verifier=Join-Path $PSScriptRoot 'verify-revenue-fleet-v3.mjs'
$directory=Join-Path $root 'maintenance'
$old=@{
  server='D22F0F2DB2E8062EA0ADBAD9D3A3377848BFE91FA5FF53F20D85D7242EC80D8F'
  coding='E7CDC97F2640D31C82715DA7EDC93AF23666B1E9A6E6E916E319DB24318C7E0A'
  helper='0FC1A6DCE04EF0CD6B63E3DBE636A52FBE0C56AB567E5B5076012FFD97BDC413'
  initializer='FE840A7ECA8A5F7FD818CA25C3380B1FAD9B1C8F79971FB4D76B396338E78E0F'
}
$files=@{server='server.mjs';coding='coding.mjs'
  helper='fleet-scoped-worktree-actions.mjs';initializer='fleet-worktree-init.mjs'}
function Digest([string]$name){
  return (Get-FileHash -LiteralPath $name -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}
function Healthy{
  try{
    $response=Invoke-WebRequest 'http://127.0.0.1:3000/health' -TimeoutSec 5 -UseBasicParsing
    $data=$response.Content|ConvertFrom-Json
    return ($response.StatusCode -eq 200 -and
      $data.upstreams.revenue_shot_preflight.state -eq 'connected')
  }catch{return $false}
}
function StopService{
  $task=Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  if($task.State -eq 'Running'){Stop-ScheduledTask -TaskName 'Codexify'}
  for($i=0;$i -lt 50;$i++){
    $task=Get-ScheduledTask -TaskName 'Codexify'
    $process=@(Get-CimInstance Win32_Process -Filter "name = 'codexify.exe'" -ErrorAction SilentlyContinue)
    $port=@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
    if($task.State -ne 'Running' -and $process.Count -eq 0 -and $port.Count -eq 0){return}
    Start-Sleep -Seconds 2
  }
  throw 'SERVICE_STOP_NOT_VERIFIED'
}
function StartService{
  Start-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
  for($i=0;$i -lt 95;$i++){
    if((Get-ScheduledTask -TaskName 'Codexify').State -eq 'Running' -and (Healthy)){return}
    Start-Sleep -Seconds 2
  }
  throw 'RESTART_HTTP_REVENUE_HEALTH_FAILED'
}
if((Digest $binary) -cne 'A07B471F1EAFEA87C6DE6C8CED4FF293284139080FB632866528C9A90B46CDC4'){
  throw 'CODEXIFY_BINARY_CHANGED'
}
foreach($key in @('server','coding','helper','initializer')){
  if((Digest (Join-Path $side $files[$key])) -cne $old[$key]){
    throw ('LIVE_MODULE_BASELINE_CHANGED_'+$key)
  }
}
$config=Get-Content (Join-Path $root 'codexify.config.json') -Raw |
  ConvertFrom-Json -ErrorAction Stop
if(@($config.mcpServers.revenue_shot_preflight.tools).Count -ne 13){
  throw 'DIRECT_APPROVED_ACTION_COUNT_NOT_13'
}
if((Get-ScheduledTask -TaskName 'Codexify').State -ne 'Running' -or !(Healthy)){
  throw 'SERVICE_NOT_HEALTHY_BEFORE_CHANGE'
}
$patches=@(Get-ScheduledTask|Where-Object{
  $_.TaskName -like 'Codexify-Patch-*' -and $_.State -eq 'Running'
})
if($patches.Count -gt 0){throw 'CONCURRENT_PATCH_TASK'}
foreach($script in @('fleet-server-v3.mjs','fleet-worktree-init.mjs',
 'fleet-coding-reader-v2.mjs','fleet-scoped-worktree-actions.mjs',
 'prepare-revenue-fleet-v3.mjs','verify-revenue-fleet-v3.mjs')){
  & node --check (Join-Path $PSScriptRoot $script)
  if($LASTEXITCODE -ne 0){throw ('NODE_SYNTAX_ERROR_'+$script)}
}
& node $installer --check
if($LASTEXITCODE -ne 0){throw 'PREPARE_V3_DRYRUN_FAILED'}
$env:REVENUE_ACTION_OWNER_APPROVAL='REVENUE_FLEET_V3'
$stamp=Get-Date
try{
  & node $installer --apply
  if($LASTEXITCODE -ne 0){throw 'OWNER_DECLINED_OR_INSTALL_FAILED'}
}finally{
  Remove-Item Env:REVENUE_ACTION_OWNER_APPROVAL -ErrorAction SilentlyContinue
}
$backups=@(Get-ChildItem -LiteralPath $directory -Directory -Filter 'fleet-v3-backup-*' |
  Where-Object{$_.LastWriteTime -ge $stamp.AddMinutes(-2)})
if($backups.Count -ne 1){throw 'UNIQUE_BACKUP_NOT_VERIFIED_NO_RESTART'}
$backup=$backups[0].FullName
$receiptFile=Join-Path $backup 'installation-receipt.json'
if(!(Test-Path -LiteralPath $receiptFile)){throw 'INSTALLATION_RECEIPT_MISSING_NO_RESTART'}
$receipt=Get-Content $receiptFile -Raw|ConvertFrom-Json
$restartAttempted=$false
try{
  foreach($key in @('server','coding','helper','initializer')){
    if((Digest (Join-Path $backup ($key+'.before'))) -cne $old[$key]){
      throw ('BACKUP_CORRUPTED_'+$key)
    }
    if((Digest (Join-Path $side $files[$key])) -cne $receipt.newHashes.$key){
      throw ('INSTALL_HASH_INVALID_'+$key)
    }
  }
  & node $verifier
  if($LASTEXITCODE -ne 0){throw 'PRE_RESTART_NATIVE_VALIDATION_FAILED'}
  $restartAttempted=$true
  StopService
  StartService
  & node $verifier
  if($LASTEXITCODE -ne 0){throw 'POST_RESTART_NATIVE_VALIDATION_FAILED'}
  Write-Output 'SUCCESS: FLEET_V3_FRESH_MAIN_READER_HTTP200'
  Write-Output ('BACKUP '+$receiptFile)
  Write-Output 'Refresh God v5 Actions to expose baseline_mode=remote-main.'
}catch{
  $failure=$_.Exception.Message
  Write-Warning ('FLEET_V3_ERROR '+$failure)
  try{
    if($restartAttempted){StopService}
    foreach($key in @('server','coding','helper','initializer')){
      $from=Join-Path $backup ($key+'.before')
      if((Digest $from) -cne $old[$key]){throw ('INVALID_BACKUP_'+$key)}
      Copy-Item -LiteralPath $from -Destination (Join-Path $side $files[$key]) -Force
      if((Digest (Join-Path $side $files[$key])) -cne $old[$key]){
        throw ('ROLLBACK_HASH_INVALID_'+$key)
      }
    }
    if($restartAttempted){StartService}
    Write-Warning 'Original v2 files restored with verified SHA256.'
  }catch{Write-Warning ('ROLLBACK_UNVERIFIED '+$_.Exception.Message)}
  throw ('FLEET_V3_ACTIVATION_FAILED '+$failure)
}
