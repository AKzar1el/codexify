# Isolated tests for a fail-closed maintenance window. Never contacts the owner API or changes services.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Installer PowerShell syntax is invalid' }
$fn = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'WaitForQuietFleet'
}, $true) | Select-Object -First 1
if (-not $fn) { throw 'The bounded wait function is missing' }
Invoke-Expression $fn.Extent.Text
$grace = $ast.FindAll({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'AssertTransientPrimaryGrace'
}, $true) | Select-Object -First 1
if (-not $grace) { throw 'The bounded transient primary grace helper is missing' }
Invoke-Expression $grace.Extent.Text

$script:statuses = @()
$script:attempts = 0
$script:sleeps = 0
$script:unknown = $false
function Probe([string[]]$blocked, [bool]$authenticatedBusy) {
    return [pscustomobject]@{
        ReadyForGuardedMaintenance=($blocked.Count -eq 0)
        InstallationBlockedBy=@($blocked)
        PrimaryBrowserStatus='idle'
        Flags=[pscustomobject]@{
            PrimaryAuthenticatedBusy=$authenticatedBusy
            PrimaryAuthenticatedUnavailable=$false
            PrimaryAuthenticationRequired=$false
            FleetStatusVerified=$true
        }
    }
}
function Preflight {
    $script:attempts++
    if ($script:unknown) { throw 'Cannot verify owner-chat session for the idle check' }
    $idx = [Math]::Min($script:attempts - 1, $script:statuses.Count - 1)
    return $script:statuses[$idx]
}
function Start-Sleep {
    [CmdletBinding()] param([int]$Seconds)
    if ($Seconds -lt 1 -or $Seconds -gt 15) { throw "Unsafe wait interval $Seconds" }
    $script:sleeps++
}
function SetScenario($sequence) {
    $script:statuses = @($sequence)
    $script:attempts = 0
    $script:sleeps = 0
    $script:unknown = $false
}

SetScenario @(
    (Probe @('FleetQuiet') $false),
    (Probe @('FleetQuiet','PrimaryAuthenticatedIdle') $true),
    (Probe @('PrimaryAuthenticatedIdle') $true),
    (Probe @() $false)
)
$ready = WaitForQuietFleet 1 | Select-Object -Last 1
if (-not $ready.ReadyForGuardedMaintenance -or $script:attempts -ne 4 -or $script:sleeps -ne 3) {
    throw 'Did not wait for both quiet fleet and authenticated idle primary'
}
Write-Output 'PASS fleet and authenticated browser become idle independently'

SetScenario @((Probe @('PrimaryAuthenticatedIdle') $true),(Probe @() $false))
$ready = WaitForQuietFleet 1 | Select-Object -Last 1
if (-not $ready.ReadyForGuardedMaintenance -or $script:attempts -ne 2 -or $script:sleeps -ne 1) {
    throw 'Transient primary activity did not wait correctly'
}
Write-Output 'PASS transient primary busy state is safely waited out'

SetScenario @((Probe @('PrimaryAuthenticatedIdle','FleetQuiet') $false),(Probe @() $false))
$script:statuses[0].PrimaryBrowserStatus = 'unavailable'
$script:statuses[0].Flags.PrimaryAuthenticatedUnavailable = $true
$ready = WaitForQuietFleet 1 | Select-Object -Last 1
if (-not $ready.ReadyForGuardedMaintenance -or $script:attempts -ne 2 -or $script:sleeps -ne 1) {
    throw 'Verified, authenticated but temporarily unavailable browser was not allowed to recover'
}
Write-Output 'PASS authenticated but unavailable composer may recover without skipping checks'

SetScenario @((Probe @('PrimaryAuthenticatedIdle') $false),(Probe @() $false))
$script:statuses[0].PrimaryBrowserStatus = 'probe_unavailable'
$ready = WaitForQuietFleet 1 | Select-Object -Last 1
if (-not $ready.ReadyForGuardedMaintenance -or $script:attempts -ne 2 -or $script:sleeps -ne 1) {
    throw 'Brief unreachable-primary health probe should recover without action or service restart'
}
Write-Output 'PASS transient primary health endpoint interruption may recover'

$now = [DateTimeOffset]::UtcNow
AssertTransientPrimaryGrace ($now.AddSeconds(-179)) $now 180
$refused = $false
try { AssertTransientPrimaryGrace ($now.AddSeconds(-181)) $now 180 } catch {
    if ($_.Exception.Message -match 'unverifiable for 180 seconds') { $refused = $true } else { throw }
}
if (-not $refused) { throw 'Unknown primary status was allowed beyond its 180-second recovery window' }
Write-Output 'PASS bounded unverified primary health grace expires fail-closed'

SetScenario @((Probe @('PrimaryAuthenticatedIdle') $false))
$script:statuses[0].PrimaryBrowserStatus = 'authentication_required'
$script:statuses[0].Flags.PrimaryAuthenticationRequired = $true
$refused = $false
try { WaitForQuietFleet 1 | Out-Null } catch {
    if ($_.Exception.Message -match '(authentication|sign.in)') { $refused = $true } else { throw }
}
if (-not $refused -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Explicit sign-in requirement must not be mistaken for transient unavailability'
}
Write-Output 'PASS explicit authentication requirement fails immediately'

SetScenario @((Probe @('PrimaryAuthenticatedIdle') $false))
$refused = $false
try { WaitForQuietFleet 1 | Out-Null } catch {
    if ($_.Exception.Message -match 'PrimaryAuthenticatedIdle') { $refused = $true } else { throw }
}
if (-not $refused -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'An unauthenticated, missing or unknown primary was treated as waitable'
}
Write-Output 'PASS unverified primary state fails closed'

SetScenario @((Probe @('FleetQuiet','CandidateBrowserRuntimeCompatible') $false))
$refused = $false
try { WaitForQuietFleet 1 | Out-Null } catch {
    if ($_.Exception.Message -match 'CandidateBrowserRuntimeCompatible') { $refused = $true } else { throw }
}
if (-not $refused -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'A non-waitable prerequisite was ignored'
}
Write-Output 'PASS non-transient installation gate fails closed'

SetScenario @((Probe @('FleetQuiet') $false))
$script:statuses[0].Flags.FleetStatusVerified = $false
$refused = $false
try { WaitForQuietFleet 1 | Out-Null } catch {
    if ($_.Exception.Message -match 'cannot be verified') { $refused = $true } else { throw }
}
if (-not $refused -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Unverifiable fleet status was treated as legitimately busy'
}
Write-Output 'PASS unavailable fleet status fails closed, rather than waiting'

SetScenario @((Probe @('FleetQuiet') $false))
$script:unknown = $true
$refused = $false
try { WaitForQuietFleet 1 | Out-Null } catch {
    if ($_.Exception.Message -match 'Cannot verify owner-chat session') { $refused = $true } else { throw }
}
if (-not $refused -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Unknown owner state did not fail closed immediately'
}
Write-Output 'PASS unknown owner-API state fails closed'

SetScenario @((Probe @('PrimaryAuthenticatedIdle') $true))
$timedOut = $false
try { WaitForQuietFleet 0 | Out-Null } catch {
    if ($_.Exception.Message -match 'no installation started') { $timedOut = $true } else { throw }
}
if (-not $timedOut -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Quiet-window deadline was not enforced'
}
Write-Output 'PASS bounded maintenance-window deadline refuses safely'

SetScenario @((Probe @() $false))
$ready = WaitForQuietFleet 1 | Select-Object -Last 1
if (-not $ready.ReadyForGuardedMaintenance -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Ready fleet and browser unnecessarily waited'
}
Write-Output 'PASS already-ready maintenance window returns immediately'
Write-Output 'FLEET_AND_PRIMARY_IDLE_WAIT_TESTS_PASS'
