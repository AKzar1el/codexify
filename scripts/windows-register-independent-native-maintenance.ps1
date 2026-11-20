# Safely launch an authorized native Codexify maintenance from an independent
# Administrator-level Windows Scheduled Task. Without -Deploy: read-only.
# Do not call the native installer directly from a Codexify tool or UAC child.
param(
  [switch]$Deploy,
  [switch]$InterruptNativeCommands,
  [string]$ExpectedCandidateSha256
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profile = [IO.Path]::GetFullPath($env:USERPROFILE)
$root = Join-Path $profile '.codexify'
$installed = Join-Path $root 'bin\codexify.exe'
$candidate = Join-Path $project 'target\debug\codexify.exe'
$wrapper = Join-Path $PSScriptRoot 'windows-native-readiness-task-wrapper.ps1'
$taskName = 'Codexify-Native-Readiness-Maintenance'
$gitExe = (Get-Command git -ErrorAction Stop).Source

foreach($path in @($installed,$candidate,$wrapper)){
  if(-not(Test-Path -LiteralPath $path -PathType Leaf)){
    throw "Missing local maintenance prerequisite: $path"
  }
}
$sha = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
$installedSha = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant()
$head = (& $gitExe -C $project rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$'){
  throw 'Cannot verify local source commit'
}
$commitSeconds = (& $gitExe -C $project show -s --format=%ct HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $commitSeconds -notmatch '^\d+$'){
  throw 'Cannot verify commit timestamp'
}
$commitTime = [DateTimeOffset]::FromUnixTimeSeconds([long]$commitSeconds).UtcDateTime
$candidateTime = (Get-Item -LiteralPath $candidate).LastWriteTimeUtc
$sourceDirty = -not [string]::IsNullOrWhiteSpace(((& $gitExe -C $project status --porcelain) -join ''))
if($LASTEXITCODE -ne 0){throw 'Cannot verify source cleanliness'}
$candidateFresh = $candidateTime -gt $commitTime

'HEAD='+$head
'CANDIDATE_SHA='+$sha
'INSTALLED_SHA='+$installedSha
'CANDIDATE_NEWER_THAN_HEAD='+$candidateFresh
'SOURCE_CLEAN='+(-not $sourceDirty)

if(-not $Deploy){
  'DRY_RUN_ONLY=true'
  'WINDOWS_TASK_AND_NATIVE_EXECUTABLE_UNCHANGED=true'
  return
}
if($sourceDirty){throw 'Worktree has uncommitted changes; cannot deploy'}
if(-not $candidateFresh){throw 'Candidate was built before the current source commit; rebuild first'}
if([string]::IsNullOrWhiteSpace($ExpectedCandidateSha256) -or
   $ExpectedCandidateSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
   $sha -ne $ExpectedCandidateSha256.ToLowerInvariant()){
  throw 'Candidate SHA must be explicitly confirmed before elevated deployment'
}
if($sha -eq $installedSha){throw 'Candidate is already installed; no restart needed'}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  throw 'Run as Administrator to register the independent highest-privilege maintenance task'
}
if(Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue){
  throw 'Maintenance task already exists; refusing duplicate'
}
$nativeTask = Get-ScheduledTask -TaskName 'Codexify' -TaskPath '\' -ErrorAction Stop
if($nativeTask.State -ne 'Running' -or -not $nativeTask.Settings.Enabled){
  throw 'Existing native scheduled task is not healthy and enabled'
}
try{
  $health = Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 5
  if($health.status -ne 'ok'){throw 'Native health is not ok'}
}catch{throw 'Native HTTP health is unavailable; refusing restart'}
$descriptor = Get-Content -LiteralPath (Join-Path $root 'browser\descriptor.json') -Raw |
  ConvertFrom-Json
$browser = Invoke-RestMethod ($descriptor.endpoint.TrimEnd('/')+'/v1/health?ready=1') -Headers @{
  Authorization='Bearer '+$descriptor.token
} -TimeoutSec 5
if($browser.status -ne 'idle' -or -not $browser.authenticated -or
   $browser.availableActionSlots -lt 1 -or
   @($browser.activeActionIds|Where-Object {$_}).Count -ne 0){
  throw 'Browser is busy or unverified; refusing native maintenance'
}

$report = Join-Path $root ('backups\native-readiness-task-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
[void](New-Item -Path $report -ItemType Directory)
$engine = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+
  $wrapper+'" -Candidate "'+$candidate+'" -ReportDirectory "'+$report+
  '" -ExpectedProfile "'+$profile+'" -Deploy'
if($InterruptNativeCommands){$arguments += ' -InterruptNativeCommands'}
$action = New-ScheduledTaskAction -Execute $engine -Argument $arguments -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -MultipleInstances IgnoreNew
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$registered = Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Settings $settings -Principal $taskPrincipal -Description 'Explicit one-time native maintenance; zero automatic triggers' -ErrorAction Stop
if(@($registered.Triggers|Where-Object {$_}).Count -ne 0 -or
   $registered.Principal.RunLevel -ne 'Highest'){
  throw 'Unexpected task privileges or triggers; task not started'
}
Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
'INDEPENDENT_ELEVATED_MAINTENANCE_STARTED=true'
'RECEIPT_PATH='+$report
'NO_AUTOMATIC_TRIGGERS=true'
'FOLLOW_DEPLOYMENT_LOG_AND_REMOVE_TASK_AFTER_COMPLETION=true'
