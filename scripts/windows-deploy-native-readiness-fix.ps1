param([Parameter(Mandatory=$true)][string]$Candidate,[switch]$Deploy)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=Join-Path $env:USERPROFILE '.codexify'
$live=Join-Path $root 'bin\codexify.exe'
$rootFull=[IO.Path]::GetFullPath($root)
$candidateFull=[IO.Path]::GetFullPath($Candidate)
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $candidateFull.StartsWith((Join-Path $project 'target\debug\'),[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($candidateFull) -cne 'codexify.exe'){
  throw 'Candidate must be the verified local Codexify debug executable'
}
foreach($p in @($live,$candidateFull)){
  if(-not(Test-Path -LiteralPath $p -PathType Leaf)){throw 'Required native executable missing'}
  if((Get-Item -LiteralPath $p).Length -lt 10000000){throw 'Native binary unexpectedly small'}
}
function Hash([string]$path){return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
$oldHash=Hash $live
$newHash=Hash $candidateFull
if($oldHash -eq $newHash){Write-Output 'ALREADY_INSTALLED=true';return}
if(-not $Deploy){
  Write-Output ('DRY_RUN_CANDIDATE_SHA='+$newHash)
  Write-Output ('DRY_RUN_INSTALLED_SHA='+$oldHash)
  Write-Output 'NO_SERVICE_OR_FILE_CHANGES=true'
  return
}
$backup=Join-Path $root ('backups\native-readiness-fix-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
[void](New-Item -ItemType Directory -Path $backup)
$old=Join-Path $backup 'codexify.before.exe'
$failed=Join-Path $backup 'codexify.failed.exe'
$stage=Join-Path $root 'bin\codexify.incoming-readiness.exe'
if(Test-Path -LiteralPath $stage){throw 'A staged native executable already exists; aborting'}
Copy-Item -LiteralPath $live -Destination $old
if((Hash $old) -ne $oldHash){throw 'Rollback executable hash mismatch'}
Copy-Item -LiteralPath $candidateFull -Destination $stage
if((Hash $stage) -ne $newHash){throw 'Staged executable hash mismatch'}
$oldReceipt=@{beforeSha=$oldHash;afterSha=$newHash;startUtc=[DateTime]::UtcNow.ToString('o');phase='prepared';backup=$backup}
$oldReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $backup 'receipt.json')
function RunCli([string]$exe,[string[]]$arguments){
  $stdout=Join-Path $backup (($arguments -join '-')+'.stdout')
  $stderr=Join-Path $backup (($arguments -join '-')+'.stderr')
  $p=Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null=$p.Handle
  if(-not $p.WaitForExit(60000)){throw 'Codexify CLI did not exit within deadline'}
  $p.Refresh()
  if($null -ne $p.ExitCode -and $p.ExitCode -ne 0){throw ('Codexify CLI failed; inspect '+$stderr)}
}
function Ready {
  try {
    $h=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 4
    return $h.status -eq 'ok'
  } catch{return $false}
}
function Idle {
  try {
    $h=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 5
    if($h.status -ne 'ok' -or $h.filesystem.occupiedWorkerSlots -gt 0 -or $h.filesystem.queuedRequests -gt 0){return $false}
    foreach($u in $h.upstreams.PSObject.Properties){if($u.Value.activeRequests -gt 0 -or $u.Value.queuedRequests -gt 0){return $false}}
    $desc=Join-Path $root 'browser\descriptor.json'
    if(Test-Path -LiteralPath $desc){
      $d=Get-Content -LiteralPath $desc -Raw|ConvertFrom-Json
      $state=Invoke-RestMethod -Uri ($d.endpoint.TrimEnd('/')+'/v1/health') -Headers @{Authorization='Bearer '+$d.token} -TimeoutSec 5
      if($state.status -ne 'idle' -or -not $state.authenticated -or $state.availableActionSlots -lt 1 -or
         $state.activeActionId -or @($state.activeActionIds).Count -gt 0){return $false}
    }
    return $true
  }catch{return $false}
}
$stopped=$false
$replaced=$false
try {
  Write-Output 'STAGE_VERIFIED=true'
  $deadline=[DateTime]::UtcNow.AddMinutes(3)
  while(-not(Idle) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Seconds 3}
  if(-not(Idle)){throw 'Native or browser activity remained busy; original service preserved'}
  Write-Output 'IDLE_WINDOW_VERIFIED=true'
  $stopped=$true
  RunCli $live @('service','stop')
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  while([DateTime]::UtcNow -lt $deadline){
    $p=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'"|Where-Object {$_.ExecutablePath -ieq $live})
    if($p.Count -eq 0){break}
    Start-Sleep -Milliseconds 500
  }
  if($p.Count -ne 0){throw 'Original Codexify service did not stop; binary untouched'}
  if((Hash $live) -ne $oldHash){throw 'Installed binary changed after the preflight; refusing replacement'}
  # File.Replace is an atomic same-volume swap; an interrupted copy cannot
  # leave the only installed executable missing.
  [IO.File]::Replace($stage,$live,(Join-Path $backup 'codexify.original-slot.exe'),$true)
  $replaced=$true
  if((Hash $live) -ne $newHash){throw 'Installed executable hash mismatch'}
  RunCli $live @('service','start')
  $deadline=[DateTime]::UtcNow.AddSeconds(80)
  while(-not(Ready) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Seconds 2}
  if(-not(Ready)){throw 'Updated native service did not reach healthy status'}
  $descriptorPath=Join-Path $root 'browser\descriptor.json'
  $browserLive=$false
  if(Test-Path -LiteralPath $descriptorPath){
    try {
      $d=Get-Content -LiteralPath $descriptorPath -Raw|ConvertFrom-Json
      $l=Invoke-RestMethod -Uri ($d.endpoint.TrimEnd('/')+'/v1/liveness') -Headers @{Authorization='Bearer '+$d.token} -TimeoutSec 6
      $browserLive=$l.available -eq $true
    }catch{}
  }
  if(-not $browserLive){
    RunCli $live @('browser','start')
    Start-Sleep -Seconds 3
    $d=Get-Content -LiteralPath $descriptorPath -Raw|ConvertFrom-Json
    $l=Invoke-RestMethod -Uri ($d.endpoint.TrimEnd('/')+'/v1/liveness') -Headers @{Authorization='Bearer '+$d.token} -TimeoutSec 6
    if($l.available -ne $true){throw 'Browser companion liveness was not restored'}
  }
  $oldReceipt.phase='completed';$oldReceipt.endUtc=[DateTime]::UtcNow.ToString('o')
  $oldReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $backup 'receipt.json')
  Write-Output ('NATIVE_INSTALLED_AND_HEALTHY=true;BACKUP='+$backup)
} catch {
  $failure=$_.Exception.Message
  Write-Output ('INSTALL_FAILURE='+$failure)
  $oldReceipt.phase='failed';$oldReceipt.error=$failure
  if($replaced){
    try {
      try {RunCli $live @('service','stop')} catch {}
      Start-Sleep -Seconds 2
      $alive=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'"|Where-Object {$_.ExecutablePath -ieq $live})
      if($alive.Count){throw 'Replacement still executing; no overwrite performed'}
      Move-Item -LiteralPath $live -Destination $failed
      Copy-Item -LiteralPath $old -Destination $live
      if((Hash $live) -ne $oldHash){throw 'Rollback verification failed'}
      RunCli $live @('service','start')
      Write-Output 'ROLLBACK_BINARY_VERIFIED=true'
      $oldReceipt.phase='rolled_back'
    }catch{
      $oldReceipt.rollbackError=$_.Exception.Message
      Write-Output ('ROLLBACK_REQUIRES_ATTENTION='+$_.Exception.Message)
    }
  }elseif($stopped){
    try {RunCli $live @('service','start')}catch {Write-Output ('SERVICE_RESTART_FAILED='+$_.Exception.Message)}
  }
  $oldReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $backup 'receipt.json')
  throw
} finally{
  if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue}
}
