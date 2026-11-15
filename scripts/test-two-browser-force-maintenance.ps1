# Completely mocked force-install gating. No Codexify service or browser is touched.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer syntax invalid' }
foreach ($name in @('AssertReadyForInstall','AssertBrowserIdleBeforeShutdown')) {
    $fn=@($ast.FindAll({param($n)
        $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
    },$true))
    if ($fn.Count -ne 1) { throw "Required force guard function missing: $name" }
    Invoke-Expression $fn[0].Extent.Text
}
$CanaryTaskKey = ''
$ForceMaintenance = $true
$forced=[pscustomobject]@{
    ReadyForGuardedMaintenance=$false
    InstallationBlockedBy=@('FleetQuiet','PrimaryAuthenticatedIdle')
}
AssertReadyForInstall $forced
Write-Output 'PASS explicit force bypasses worker and browser idle only'
foreach($gate in @('SharedGateNotHeld','AdministrativelyElevated','ScheduledServiceRunning',
                    'CandidateNativeFresh','CandidateCompanionFresh','CandidateBrowserRuntimeCompatible')) {
    $probe=[pscustomobject]@{
        ReadyForGuardedMaintenance=$false
        InstallationBlockedBy=@('FleetQuiet','PrimaryAuthenticatedIdle',$gate)
    }
    $rejected=$false
    try { AssertReadyForInstall $probe } catch {
        if ($_.Exception.Message -match [regex]::Escape($gate)) { $rejected=$true } else { throw }
    }
    if (-not $rejected) { throw "Force mode bypassed hard installation gate: $gate" }
    Write-Output "PASS force still rejects $gate"
}
$ForceMaintenance = $false
$rejected=$false
try { AssertReadyForInstall $forced } catch {
    if ($_.Exception.Message -match 'FleetQuiet') { $rejected=$true } else { throw }
}
if (-not $rejected) { throw 'Non-forced mode ignored a closed FleetQuiet gate' }
Write-Output 'PASS ordinary mode still rejects active workers'

# There is deliberately no executable at this path; force must not invoke it.
$target = Join-Path $env:TEMP 'nonexistent-codexify-installer-test.exe'
$ForceMaintenance = $true
AssertBrowserIdleBeforeShutdown
Write-Output 'PASS force skips only the idle browser probe'
$ForceMaintenance = $false
$rejected=$false
try { AssertBrowserIdleBeforeShutdown } catch { $rejected=$true }
if (-not $rejected) { throw 'Normal maintenance unexpectedly skipped browser health proof' }
Write-Output 'PASS ordinary mode still requires browser health evidence'

# Check the executable force path has the supervisor-first shutdown ordering.
$source=Get-Content -LiteralPath $path -Raw
if ($source -notmatch '(?s)if \(\$ForceMaintenance\) \{\s*# Stop the supervisor FIRST.*?& \$target service disable.*?& \$target browser stop-for-restart') {
    throw 'Forced maintenance must disable the supervisor before retiring browser'
}
if ($source -notmatch '(?s)if \(\$ForceMaintenance -and .*?-or \$CanaryTaskKey\)\)') {
    throw 'Forced mode must disallow canary activation and incompatible switches'
}
Write-Output 'PASS forced shutdown ordering and parameter restrictions remain enforced'
Write-Output 'FORCE_MAINTENANCE_GUARDS_PASS'
