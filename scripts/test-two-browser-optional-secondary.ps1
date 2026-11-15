# Offline fixture: verifies lane-2 canary is required only when enabled.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installPath = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$preflightPath = Join-Path $PSScriptRoot 'preflight-two-browser-rollout.ps1'
function LoadFunction([string]$path,[string]$name) {
    $t=$null; $e=$null
    $ast = [Management.Automation.Language.Parser]::ParseFile($path,[ref]$t,[ref]$e)
    if ($e.Count) { throw "Invalid PowerShell syntax in $path" }
    $def = @($ast.FindAll({param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $name
    },$true))
    if ($def.Count -ne 1) { throw "Missing function $name" }
    return $def[0].Extent.Text
}
# Define mocking helpers before loading the guard functions.
$root = 'C:\TwoBrowserOptionalFixture'
$script:secondaryOnline = $false
$script:primaryHealthy = $true
$script:checked = @()
function Get-CompanionState { param([string]$descriptor)
    if (-not $script:secondaryOnline) { throw 'Simulated secondary browser unreachable' }
    return [pscustomobject]@{Auth=$true;Idle=$true;Pid=40001}
}
function BrowserProof { param([string]$descriptor)
    $script:checked += $descriptor
    if (-not $script:primaryHealthy) { throw 'Simulated primary Send gate unhealthy' }
    return [pscustomobject]@{account='verified';gate=('a'*64);pid=40000}
}
function AssertTwoBrowsersGuarded { $script:checked += 'both-companions'; if (-not $script:secondaryOnline){throw 'Secondary unavailable'} }
Invoke-Expression (LoadFunction $preflightPath 'Get-SecondaryStateForInstall')
Invoke-Expression (LoadFunction $installPath 'AssertEnabledBrowserGates')

$missing = Get-SecondaryStateForInstall 'mock-descriptor' $false
if ($null -ne $missing) { throw 'Optional offline secondary was not omitted' }
Write-Output 'PASS disabled lane tolerates missing secondary at preflight'
$failed = $false
try { Get-SecondaryStateForInstall 'mock-descriptor' $true | Out-Null } catch {
    if ($_.Exception.Message -match 'unreachable') { $failed=$true } else { throw }
}
if (-not $failed) { throw 'Enabled canary silently swallowed secondary outage' }
Write-Output 'PASS enabled canary requires reachable secondary at preflight'
$script:secondaryOnline = $true
if (-not (Get-SecondaryStateForInstall 'mock-descriptor' $false).Auth) {
    throw 'Healthy optional secondary was not retained'
}
Write-Output 'PASS reachable optional secondary retains health evidence'

$script:secondaryOnline = $false
$script:checked = @()
AssertEnabledBrowserGates ''
if ($script:checked.Count -ne 1 -or $script:checked[0] -notmatch 'descriptor\.json$') {
    throw 'Disabled lane did not verify just the primary companion'
}
Write-Output 'PASS after upgrade disabled lane requires healthy primary Send gate only'

$script:checked = @()
$script:primaryHealthy = $false
$failed = $false
try { AssertEnabledBrowserGates '' } catch {
    if ($_.Exception.Message -match 'primary Send gate') { $failed = $true } else { throw }
}
if (-not $failed -or $script:checked.Count -ne 1) {
    throw 'Disabled lane skipped a failing primary Send gate'
}
Write-Output 'PASS unhealthy primary Send gate fails closed'

$script:primaryHealthy = $true
$script:checked = @()
$script:secondaryOnline = $true
AssertEnabledBrowserGates ('c'*64)
if ($script:checked.Count -ne 1 -or $script:checked[0] -ne 'both-companions') {
    throw 'Canary lane did not enforce dual-companion verification'
}
$script:secondaryOnline = $false
$failed = $false
try { AssertEnabledBrowserGates ('c'*64) } catch {
    if ($_.Exception.Message -match 'Secondary unavailable') { $failed = $true } else { throw }
}
if (-not $failed) { throw 'Enabled canary ignored a missing second companion' }
Write-Output 'PASS enabled canary verifies both browser companions and shared Send gate'
Write-Output 'OPTIONAL_SECONDARY_TESTS_PASS'
