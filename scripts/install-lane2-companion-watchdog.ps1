# Install the fail-closed lane-2 watchdog as an independent per-user task.
[CmdletBinding()]
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$name='Codexify-Lane2-Companion-Watchdog'
$watchdogSource=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'watch-lane2-companion.ps1')).ProviderPath
$watchdogRoot=Join-Path $env:USERPROFILE '.codexify\browser-pool\watchdogs'
$watchdog=Join-Path $watchdogRoot 'lane2.ps1'
$repository=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
if (-not (Test-Path -LiteralPath $watchdogSource -PathType Leaf)) { throw 'Watchdog source script missing' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogSource -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'Watchdog selftest failed; cannot register task' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogSource
if ($LASTEXITCODE -ne 0) { throw 'Live watchdog safety preflight failed' }
$who=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$whoSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Test-CurrentUserPrincipal([string]$UserId) {
    if ([string]::IsNullOrWhiteSpace($UserId)) { return $false }
    try {
        $identity=New-Object Security.Principal.NTAccount($UserId)
        $sid=$identity.Translate([Security.Principal.SecurityIdentifier])
        return ([string]$sid.Value -ceq $whoSid)
    } catch { return $false }
}
$binary=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$args='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$watchdog+'" -Apply'
$oldArgs='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$watchdogSource+'" -Apply'
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
    $actions=@($existing.Actions)
    if ($actions.Count -ne 1 -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$actions[0].Execute),
            [IO.Path]::GetFullPath($binary),[StringComparison]::OrdinalIgnoreCase) -or
        ([string]$actions[0].Arguments -cne $args -and
         [string]$actions[0].Arguments -cne $oldArgs) -or
        -not (Test-CurrentUserPrincipal ([string]$existing.Principal.UserId))) {
        throw 'Existing watchdog task belongs to a different executable, principal or script'
    }
}
$action=New-ScheduledTaskAction -Execute $binary -Argument $args -WorkingDirectory $repository
# Repetition is bounded by the Windows Task Scheduler maximum date; logon
# trigger also guarantees a fresh check at every new interactive session.
$everyMinute=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$atLogon=New-ScheduledTaskTrigger -AtLogOn -User $who
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal=New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
Write-Output ('WATCHDOG_TASK_NAME='+$name)
Write-Output ('WATCHDOG_INSTALLED_SCRIPT='+$watchdog)
Write-Output ('WATCHDOG_PRINCIPAL='+$who+' INTERACTIVE_NO_ELEVATION=True')
Write-Output 'WATCHDOG_INTERVAL=1_minute LOGON_CHECK=True'
if (-not $Apply) { Write-Output 'WATCHDOG_TASK_INSTALL_PREFLIGHT_OK';return }
if (-not (Test-Path -LiteralPath $watchdogRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $watchdogRoot -Force | Out-Null
}
$directory=Get-Item -LiteralPath $watchdogRoot -Force
if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Watchdog installation directory cannot be a reparse point'
}
$staged=Join-Path $watchdogRoot ('.lane2.'+[Guid]::NewGuid().ToString('N')+'.tmp')
try {
    Copy-Item -LiteralPath $watchdogSource -Destination $staged -ErrorAction Stop
    Move-Item -LiteralPath $staged -Destination $watchdog -Force -ErrorAction Stop
} finally {
    if(Test-Path -LiteralPath $staged){Remove-Item -LiteralPath $staged -Force}
}
if ((Get-FileHash -LiteralPath $watchdog -Algorithm SHA256).Hash -cne
    (Get-FileHash -LiteralPath $watchdogSource -Algorithm SHA256).Hash) {
    throw 'Installed watchdog content differs from verified source'
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'Installed watchdog selftest failed' }
$registered=Register-ScheduledTask -TaskName $name -Action $action -Trigger @($everyMinute,$atLogon) -Settings $settings -Principal $principal -Description 'Codexify: restart only a dead lane-2 companion; never replay accepted Sends; preserve isolated Chrome profile.' -Force -ErrorAction Stop
if (-not $registered) { throw 'Windows did not register the watchdog' }
$installed=Get-ScheduledTask -TaskName $name -ErrorAction Stop
if ($installed.State -eq 'Disabled') { throw 'Watchdog task was registered in disabled state' }
if (-not (Test-CurrentUserPrincipal ([string]$installed.Principal.UserId))) {
    throw 'Registered watchdog principal SID differs from current signed-in owner'
}
Write-Output ('WATCHDOG_TASK_INSTALLED='+[string]$installed.State)
# Explicit first-run invocation tests that a healthy restored companion is
# detected, without waiting for the next minute. Task Scheduler owns the run.
Start-ScheduledTask -TaskName $name -ErrorAction Stop
Write-Output 'WATCHDOG_FIRST_SCHEDULED_CHECK_DISPATCHED'
