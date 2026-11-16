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

# A selected, already paired canary can be activated during owner-authorized
# maintenance, but the matching cross-process Send admission gate is mandatory.
$ForceMaintenance = $true
$CanaryTaskKey = 'a' * 64
$flags=[pscustomobject]@{
    CanaryTaskKeyValid=$true
    SecondaryAuthenticatedIdle=$true
    DistinctBrowserProcesses=$true
    SameVerifiedAccount=$true
    BothCompanionsGateEnabledAndMatching=$true
}
$canary=[pscustomobject]@{
    ReadyForGuardedMaintenance=$false
    InstallationBlockedBy=@('FleetQuiet','PrimaryAuthenticatedIdle')
    Flags=$flags
}
AssertReadyForInstall $canary
Write-Output 'PASS forced maintenance allows a fully verified selected canary'
foreach($flag in @('CanaryTaskKeyValid','SecondaryAuthenticatedIdle',
                   'DistinctBrowserProcesses','SameVerifiedAccount',
                   'BothCompanionsGateEnabledAndMatching')) {
    $flags.$flag=$false
    $rejected=$false
    try { AssertReadyForInstall $canary } catch {
        if ($_.Exception.Message -match [regex]::Escape($flag)) { $rejected=$true } else { throw }
    }
    if (-not $rejected) { throw "Forced canary bypassed safety proof: $flag" }
    $flags.$flag=$true
    Write-Output "PASS forced canary rejects missing $flag"
}
$CanaryTaskKey = ''

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
if ($source -notmatch '(?s)if \(\$ForceMaintenance -and .*?-or \$WaitForFleetQuiet\)\)') {
    throw 'Forced mode must disallow incompatible switches'
}
if ($source -notmatch '(?s)AssertReadyForInstall \(Preflight\)\s*if \(\$CanaryTaskKey\) \{.*?AssertCanaryBelongsToPairedGoal \$CanaryTaskKey\s*AssertTwoBrowsersGuarded\s*\}\s*Report .stopping.') {
    throw 'A selected canary must be revalidated immediately before service shutdown'
}
if ($source -notmatch '(?s)if \(\$activationConfigOnly\) \{\s*\[IO.File\]::Replace\(\$configStage, \$configFile, \$failedConfig, \$true\).*?\} else \{\s*\[IO.File\]::Replace\(\$stage, \$target, \$failed, \$true\)') {
    throw 'An unchanged native/browser release must activate the canary with a config-only transaction'
}
if ($source -notmatch '(?s)\[IO.File\]::Replace\(\$restoreConfig, \$configFile.*?if \(-not \$activationConfigOnly\) \{.*?\[IO.File\]::Replace\(\$restoreAsar, \$asar') {
    throw 'Config-only rollback must avoid replacing the in-use browser bundle'
}
Write-Output 'PASS forced shutdown, canary revalidation and parameter restrictions remain enforced'
Write-Output 'FORCE_MAINTENANCE_GUARDS_PASS'
