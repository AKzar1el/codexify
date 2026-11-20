param(
  [Parameter(Mandatory=$true)][string]$Candidate,
  [Parameter(Mandatory=$true)][string]$ReportDirectory,
  [switch]$Deploy
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
$installer=Join-Path $PSScriptRoot 'windows-deploy-native-readiness-fix.ps1'
try {
  & $installer -Candidate $Candidate -Deploy:$Deploy 2>&1 | ForEach-Object {
    $line=($_|Out-String).Trim()
    if($line){Record $line}
  }
  Record 'MAINTENANCE_RESULT=completed'
  exit 0
} catch {
  Record ('MAINTENANCE_RESULT=failed ERROR='+$_.Exception.Message)
  exit 1
}
