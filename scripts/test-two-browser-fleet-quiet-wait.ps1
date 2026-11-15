# Isolated tests of the installer's wait loop. Never contacts the owner API or changes services.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $scriptPath, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw 'Installer PowerShell syntax is invalid' }
$waitFunction = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'WaitForQuietFleet'
}, $true) | Select-Object -First 1
if (-not $waitFunction) { throw 'The bounded FleetQuiet wait function is missing' }
Invoke-Expression $waitFunction.Extent.Text

$script:attempts = 0
$script:sleeps = 0
$script:mode = 'busy_then_idle'
function AssertFleetQuiet {
    $script:attempts++
    if ($script:mode -eq 'unknown') { throw 'Cannot verify owner-chat session for the idle check' }
    if ($script:mode -eq 'busy_forever' -or
        ($script:mode -eq 'busy_then_idle' -and $script:attempts -lt 3)) {
        throw 'Other Codexify workers were active in the last three minutes: mcp-geo'
    }
}
function Start-Sleep {
    param([int]$Seconds)
    if ($Seconds -lt 1 -or $Seconds -gt 15) { throw "Unsafe wait interval $Seconds" }
    $script:sleeps++
}

WaitForQuietFleet 1 | Out-Null
if ($script:attempts -ne 3 -or $script:sleeps -ne 2) {
    throw 'Quiet wait did not retry busy workers exactly twice'
}
Write-Output 'PASS busy workers clear without bypassing the guard'

$script:mode = 'unknown'
$script:attempts = 0
$script:sleeps = 0
$refused = $false
try { WaitForQuietFleet 1 | Out-Null } catch {
    if ($_.Exception.Message -match 'Cannot verify owner-chat session') { $refused = $true }
    else { throw }
}
if (-not $refused -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Unknown fleet status did not fail closed immediately'
}
Write-Output 'PASS unverified fleet state fails closed'

$script:mode = 'busy_forever'
$script:attempts = 0
$script:sleeps = 0
$timedOut = $false
try { WaitForQuietFleet 0 | Out-Null } catch {
    if ($_.Exception.Message -match 'no installation started') { $timedOut = $true }
    else { throw }
}
if (-not $timedOut -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Timed-out maintenance wait did not fail without starting installation'
}
Write-Output 'PASS exhausted quiet-window deadline aborts safely'

$script:mode = 'idle'
$script:attempts = 0
$script:sleeps = 0
WaitForQuietFleet 1 | Out-Null
if ($script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Idle fleet unnecessarily waited'
}
Write-Output 'PASS already-quiet fleet returns immediately'
Write-Output 'FLEET_QUIET_WAIT_TESTS_PASS'
