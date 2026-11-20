param(
  [Parameter(Mandatory=$true)][string]$Candidate,
  [Parameter(Mandatory=$true)][string]$ReportDirectory,
  [switch]$Deploy,
  [switch]$InterruptNativeCommands,
  [string]$ExpectedProfile
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=Join-Path $env:USERPROFILE '.codexify\backups'
$report=[IO.Path]::GetFullPath($ReportDirectory)
if(-not $report.StartsWith(([IO.Path]::GetFullPath($root).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){
  throw 'Maintenance report path is not under Codexify backups'
}
[void](New-Item -ItemType Directory -Path $report -Force)
$log=Join-Path $report ($(if($Deploy){'deploy'}else{'dryrun'})+'.log')
function Record([string]$message) {
  $line=([DateTime]::UtcNow.ToString('o')+' '+$message)
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
}
$parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
$parentPid=if($parent){[int]$parent.ParentProcessId}else{0}
$ancestor=if($parentPid){Get-CimInstance Win32_Process -Filter ('ProcessId='+$parentPid)}else{$null}
Record ('MAINTENANCE_MODE='+$(if($Deploy){'deploy'}else{'dryrun'})+
    ' SCRIPT_PID='+$PID+' PARENT_PID='+$parentPid+
    ' PARENT_IMAGE='+$(if($ancestor){$ancestor.Name}else{'unknown'}))
$taskName='Codexify-Native-Readiness-Maintenance'
if($Deploy){
  # Start-Process -Verb RunAs from a Codexify tool can still belong to the
  # service's Windows job. That elevated helper can die when the native server
  # stops, leaving Task Scheduler disabled. Only an independently launched
  # on-demand, highest-privilege Scheduled Task is allowed to deploy.
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=[Security.Principal.WindowsPrincipal]::new($identity)
  if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'Deployment requires an elevated independent Task Scheduler launcher'
  }
  $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  $taskArguments=[string]$task.Actions[0].Arguments
  if(-not $ancestor -or $ancestor.Name -ine 'svchost.exe' -or
     $task.State -ne 'Running' -or $task.Principal.RunLevel -ne 'Highest' -or
     @($task.Triggers|Where-Object {$_}).Count -ne 0 -or
     @($task.Actions).Count -ne 1 -or
     $taskArguments -notlike '*windows-native-readiness-task-wrapper.ps1*' -or
     $taskArguments -notlike '*-Deploy*' -or
     $taskArguments -notlike ('*'+$ReportDirectory+'*') -or
     $taskArguments -notlike ('*'+$Candidate+'*')){
    throw 'Unverified task origin; refusing deployment from a direct elevated process'
  }
  Record 'INDEPENDENT_ELEVATED_TASK_ORIGIN_VERIFIED=true'
}
$installer=Join-Path $PSScriptRoot 'windows-deploy-native-readiness-fix.ps1'
try {
  & $installer -Candidate $Candidate -Deploy:$Deploy -InterruptNativeCommands:$InterruptNativeCommands -ExpectedProfile $ExpectedProfile 2>&1 | ForEach-Object {
    $line=($_|Out-String).Trim()
    if($line){Record $line}
  }
  Record 'MAINTENANCE_RESULT=completed'
  exit 0
} catch {
  Record ('MAINTENANCE_RESULT=failed ERROR='+$_.Exception.Message)
  exit 1
}
