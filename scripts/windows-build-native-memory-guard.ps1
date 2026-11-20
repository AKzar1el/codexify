# Bounded offline Codexify build. Never touches the installed native service.
param([switch]$Build)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$minimumStartGb = 5.0
$abortBelowGb = 1.75
$maximumMinutes = 12
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$native = Join-Path $env:USERPROFILE '.codexify\bin\codexify.exe'
$candidate = Join-Path $project 'target\debug\codexify.exe'
$git = (Get-Command git -ErrorAction Stop).Source
$cargo = (Get-Command cargo -ErrorAction Stop).Source
function FreeRamGb {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  return [math]::Round(([double]$os.FreePhysicalMemory / 1MB), 2)
}
if(-not(Test-Path -LiteralPath $native -PathType Leaf)){
  throw 'Installed native executable is missing'
}
$head = (& $git -C $project rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $head -notmatch '^[a-f0-9]{40}$'){
  throw 'Source HEAD is not verified'
}
$dirty = ((& $git -C $project status --porcelain) -join '')
if($LASTEXITCODE -ne 0 -or $dirty){throw 'Source tree is not clean'}
$task = Get-ScheduledTask -TaskName 'Codexify' -TaskPath '\' -ErrorAction Stop
if($task.State -ne 'Running' -or -not $task.Settings.Enabled){
  throw 'The installed native task is not running/enabled'
}
$health = Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 5
if($health.status -ne 'ok'){throw 'Native service is not healthy'}
$activeCompilers = @(Get-CimInstance Win32_Process -ErrorAction Stop |
  Where-Object {$_.Name -in @('cargo.exe','rustc.exe')})
$free = FreeRamGb
'CURRENT_RAM_FREE_GB='+$free
'MINIMUM_START_GB='+$minimumStartGb
'ABORT_BELOW_GB='+$abortBelowGb
'HEAD='+$head
'OTHER_COMPILERS='+$activeCompilers.Count
if(-not $Build) {
  'DRY_RUN_ONLY=true'
  'NATIVE_BINARY_UNCHANGED=true'
  return
}
if($free -lt $minimumStartGb){
  throw ("Build not started: only " + $free + " GB free RAM; require " + $minimumStartGb + " GB")
}
if($activeCompilers.Count -ne 0){throw 'Other Rust compiler tasks are running'}
if((Get-PSDrive -Name C).Free -lt 6GB){throw 'Not enough free disk for offline build'}
$report = Join-Path $env:USERPROFILE ('.codexify\backups\guarded-native-build-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
[void](New-Item -Path $report -ItemType Directory -ErrorAction Stop)
$stdout = Join-Path $report 'stdout.log'
$stderr = Join-Path $report 'stderr.log'
$receipt = Join-Path $report 'receipt.txt'
$startTime = [DateTime]::UtcNow
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_NET_OFFLINE = 'true'
$proc = $null
$originalSha = (Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash.ToLowerInvariant()
function StopOwnCompiler([int]$cargoPid,[datetime]$creationTime) {
  # Only the Cargo process launched here and its immediate Rust children.
  $children = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ParentProcessId -eq $cargoPid -and $_.Name -eq 'rustc.exe' -and
    [datetime]$_.CreationDate -ge $creationTime
  })
  foreach($child in $children) {
    $again = Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$child.ProcessId)
    if($again -and $again.Name -eq 'rustc.exe' -and
       $again.ParentProcessId -eq $cargoPid -and
       $again.CreationDate -eq $child.CreationDate){
      Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  $cargoProcess = Get-CimInstance Win32_Process -Filter ('ProcessId='+$cargoPid)
  if($cargoProcess -and $cargoProcess.Name -eq 'cargo.exe' -and
     [math]::Abs((([datetime]$cargoProcess.CreationDate)-$creationTime).TotalSeconds) -lt 2){
    Stop-Process -Id $cargoPid -Force -ErrorAction SilentlyContinue
  }
}
try {
  $proc = Start-Process -FilePath $cargo -ArgumentList 'build','--bin','codexify','--offline','--jobs','1' -WorkingDirectory $project -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
  $creation = (Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$proc.Id)).CreationDate
  'BUILD_STARTED_PID='+$proc.Id
  'BUILD_RECEIPT='+$receipt
  $deadline = [DateTime]::UtcNow.AddMinutes($maximumMinutes)
  while(-not $proc.HasExited) {
    Start-Sleep -Seconds 4
    $proc.Refresh()
    if($proc.HasExited){break}
    $free = FreeRamGb
    if($free -lt $abortBelowGb -or [DateTime]::UtcNow -ge $deadline) {
      StopOwnCompiler $proc.Id $creation
      $reason = if($free -lt $abortBelowGb){'low_memory'}else{'timeout'}
      Set-Content -LiteralPath $receipt -Value ("status=aborted;reason="+$reason+";freeGb="+$free+";head="+$head)
      throw ("Build aborted safely: " + $reason + ", free RAM " + $free + " GB")
    }
  }
  $proc.Refresh()
  if($proc.ExitCode -ne 0){
    Set-Content -LiteralPath $receipt -Value ("status=failed;exit="+$proc.ExitCode+";head="+$head)
    throw ('Cargo returned exit code '+$proc.ExitCode)
  }
  if(-not(Test-Path -LiteralPath $candidate -PathType Leaf)){
    throw 'Build reported success but candidate is missing'
  }
  $newSha = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if((Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash.ToLowerInvariant() -ne $originalSha){
    throw 'Installed executable unexpectedly changed'
  }
  $commitSeconds = (& $git -C $project show -s --format=%ct HEAD).Trim()
  if($LASTEXITCODE -ne 0){throw 'Unable to verify commit freshness'}
  $commitTime = [DateTimeOffset]::FromUnixTimeSeconds([long]$commitSeconds).UtcDateTime
  if((Get-Item -LiteralPath $candidate).LastWriteTimeUtc -le $commitTime){
    throw 'Candidate was not freshly built for current HEAD'
  }
  Set-Content -LiteralPath $receipt -Value ("status=built;head="+$head+";sha256="+$newSha)
  'BUILD_SUCCESS=true'
  'CANDIDATE_SHA='+$newSha
  'BUILD_RECEIPT='+$receipt
} finally {
  if($proc -and -not $proc.HasExited) {
    try {StopOwnCompiler $proc.Id $creation}catch{}
  }
}
