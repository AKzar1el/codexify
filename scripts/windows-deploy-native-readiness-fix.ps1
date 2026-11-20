param([Parameter(Mandatory=$true)][string]$Candidate,[switch]$Deploy,[switch]$InterruptNativeCommands)
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
# A native service replacement kills its owning Windows Job Object. When this
# installer is spawned by a Codexify tool, it belongs to the same tree and
# may be terminated halfway through the atomic swap. Require an independent
# launcher (for example, a temporary one-shot Task Scheduler task).
$ancestorPid=[int]$PID
for($depth=0;$depth -lt 16;$depth++){
  $ancestor=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ancestorPid)
  if(-not $ancestor){break}
  if($ancestor.ExecutablePath -ieq $live){
    throw 'Refusing native replacement from inside its own service process tree; use independent maintenance launcher'
  }
  if(-not $ancestor.ParentProcessId -or [int]$ancestor.ParentProcessId -eq $ancestorPid){break}
  $ancestorPid=[int]$ancestor.ParentProcessId
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
function Active-NativeChildCommands {
  # Native /health can report zero occupied MCP slots while tool sessions still
  # own long-running subprocesses (pytest, cargo, shell, etc.). Never terminate
  # the listener in that state. Persistent upstream servers created during the
  # native startup grace period are not treated as unfinished user commands.
  $listenerId=Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction Stop |
    Select-Object -First 1 -ExpandProperty OwningProcess
  if(-not $listenerId){return $true}
  $listener=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listenerId)
  if(-not $listener){return $true}
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listener.ParentProcessId)
  if(-not $supervisor -or $supervisor.ExecutablePath -ine $live){return $true}
  $startupCutoff=$supervisor.CreationDate.AddMinutes(5)
  $all=@(Get-CimInstance Win32_Process)
  $descendants=[Collections.Generic.HashSet[int]]::new()
  [void]$descendants.Add([int]$listenerId)
  do {
    $changed=$false
    foreach($process in $all){
      if($descendants.Contains([int]$process.ParentProcessId) -and
          $descendants.Add([int]$process.ProcessId)){$changed=$true}
    }
  }while($changed)
  $commands=@($all | Where-Object {
    $_.ProcessId -ne $listenerId -and $descendants.Contains([int]$_.ProcessId) -and
    $_.CreationDate -ge $startupCutoff -and
    $_.Name -match '^(powershell|pwsh|cmd|python|pytest|uv|cargo|rustc|git|node|bun|link|ninja|make|wsl)(\.exe)?$'
  })
  return $commands.Count -gt 0
}
function Idle {
  try {
    $h=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 5
    if($h.status -ne 'ok'){return $false}
    if(-not $InterruptNativeCommands){
      if($h.filesystem.occupiedWorkerSlots -gt 0 -or $h.filesystem.queuedRequests -gt 0){return $false}
      foreach($u in $h.upstreams.PSObject.Properties){if($u.Value.activeRequests -gt 0 -or $u.Value.queuedRequests -gt 0){return $false}}
      if(Active-NativeChildCommands){return $false}
    }
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
function Stop-VerifiedUnresponsiveNativePair {
  # The installed service's Windows Stop-ScheduledTask script suppresses
  # errors, so a successful CLI receipt does not prove that its processes quit.
  # Only terminate the exact installed supervisor/listener pair that was
  # verified *before* invoking service stop, and only if no work is active.
  if(-not(Idle)){throw 'Native/browser work became active; refusing forced native stop'}
  $task=Get-ScheduledTask -TaskName 'Codexify' -TaskPath '\' -ErrorAction Stop
  if(-not $task.Settings.Enabled -or $task.Principal.LogonType -ne 'Interactive' -or
     $task.Principal.RunLevel -ne 'Limited' -or
     [IO.Path]::GetFullPath([string]$task.Actions[0].WorkingDirectory) -ine [IO.Path]::GetFullPath($root) -or
     [IO.Path]::GetFullPath([string]$task.Actions[0].Execute) -ine (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')){
    throw 'Installed scheduled task identity is not trusted for a native stop'
  }
  $owners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object {$_.LocalPort -in @(3000,3120)} | Select-Object -ExpandProperty OwningProcess -Unique)
  if($owners.Count -ne 1){throw 'Unexpected owner of Codexify listening ports'}
  $listener=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owners[0])
  if(-not $listener -or $listener.ExecutablePath -ine $live){throw 'Listener executable changed'}
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listener.ParentProcessId)
  if(-not $supervisor -or $supervisor.ExecutablePath -ine $live -or
     $supervisor.CommandLine -notmatch 'service run --config'){
    throw 'Native supervisor identity changed'
  }
  $pair=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'" |
    Where-Object {$_.ExecutablePath -ieq $live})
  if($pair.Count -ne 2 -or ($pair.ProcessId -notcontains $listener.ProcessId) -or
     ($pair.ProcessId -notcontains $supervisor.ProcessId)){
    throw 'More than the verified supervisor and listener are running'
  }
  # Verify PID ownership again immediately before termination. Never kill a
  # later process that reused a PID.
  foreach($verified in @($listener,$supervisor)){
    $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$verified.ProcessId)
    if(-not $current -or $current.ExecutablePath -ine $live -or
       $current.CreationDate -ne $verified.CreationDate){
      throw 'Native process identity changed before stop'
    }
  }
  Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction Stop
  Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
  Write-Output 'VERIFIED_STALE_NATIVE_PAIR_STOPPED=true'
}
$stopped=$false
$replaced=$false
try {
  Write-Output 'STAGE_VERIFIED=true'
  if($InterruptNativeCommands){Write-Output 'AUTHORIZED_NATIVE_COMMAND_INTERRUPTION=true'}
  $deadline=[DateTime]::UtcNow.AddMinutes(3)
  while(-not(Idle) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Seconds 3}
  if(-not(Idle)){throw 'Native or browser activity remained busy; original service preserved'}
  Write-Output 'IDLE_WINDOW_VERIFIED=true'
  $originalNative=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'"|
    Where-Object {$_.ExecutablePath -ieq $live})
  $stopped=$true
  RunCli $live @('service','stop')
  $deadline=[DateTime]::UtcNow.AddSeconds(7)
  while([DateTime]::UtcNow -lt $deadline){
    $p=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'"|Where-Object {$_.ExecutablePath -ieq $live})
    if($p.Count -eq 0){break}
    Start-Sleep -Milliseconds 500
  }
  if($p.Count -gt 0){
    # The CLI currently suppresses Stop-ScheduledTask errors and can report
    # success while the scheduled task remains running. A real failure should
    # not be ignored; explicitly stop the existing task from this independent
    # maintenance process before falling back to the verified process pair.
    try {
      $task=Get-ScheduledTask -TaskName 'Codexify' -TaskPath '\' -ErrorAction Stop
      Stop-ScheduledTask -InputObject $task -ErrorAction Stop
      Write-Output 'SCHEDULED_TASK_STOP_REQUESTED=true'
    } catch {
      Write-Output ('SCHEDULED_TASK_STOP_FAILED='+$_.Exception.GetType().Name)
    }
    Start-Sleep -Seconds 3
    $p=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'"|Where-Object {$_.ExecutablePath -ieq $live})
  }
  if($p.Count -gt 0){
    $currentIds=@($p | Select-Object -ExpandProperty ProcessId | Sort-Object) -join ','
    $originalIds=@($originalNative | Select-Object -ExpandProperty ProcessId | Sort-Object) -join ','
    if($currentIds -ne $originalIds){
      throw 'A new native process started during service stop; binary untouched'
    }
    Stop-VerifiedUnresponsiveNativePair
    $deadline=[DateTime]::UtcNow.AddSeconds(12)
    do {
      $p=@(Get-CimInstance Win32_Process -Filter "Name='codexify.exe'"|Where-Object {$_.ExecutablePath -ieq $live})
      if($p.Count -eq 0){break}
      Start-Sleep -Milliseconds 500
    }while([DateTime]::UtcNow -lt $deadline)
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
      $restore=Join-Path $root 'bin\codexify.restore-readiness.exe'
      if(Test-Path -LiteralPath $restore){throw 'A native rollback stage already exists'}
      Copy-Item -LiteralPath $old -Destination $restore
      if((Hash $restore) -ne $oldHash){throw 'Rollback stage hash mismatch'}
      [IO.File]::Replace($restore,$live,$failed,$true)
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
