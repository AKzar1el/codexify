# Isolated test: executes only the idle guard extracted from the installer.
# API data and owner token are mocked; no service, task, or worker is touched.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$path = Join-Path $PSScriptRoot 'install-local-updater-fix.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $path, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count) { throw 'Installer has invalid PowerShell syntax' }
$fn = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'AssertFleetQuiet'
}, $true) | Select-Object -First 1
if (-not $fn) { throw 'Idle guard function missing from installer' }
Invoke-Expression $fn.Extent.Text
$AllowActiveWorkers = $false # The extracted installer guard normally receives this parameter

$root = Join-Path $env:TEMP ('codexify-mock-idle-' + [guid]::NewGuid().ToString('N'))
New-Item -Path $root -ItemType Directory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $root 'owner-chat.json') -Value '{"port":32123,"token":"MOCK_ONLY"}'
$script:mockChats = @()
$script:mockFailure = $false
$script:requested = 0
function Invoke-RestMethod {
    [CmdletBinding()]
    param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
    $script:requested++
    if ($Uri -ne 'http://127.0.0.1:32123/api/chats') { throw 'Unexpected API endpoint' }
    if ($Headers.Authorization -ne 'Bearer MOCK_ONLY') { throw 'Unexpected authorization' }
    if ($script:mockFailure) { throw 'Simulated owner API outage' }
    return [pscustomobject]@{chats = @($script:mockChats)}
}

try {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $script:mockChats = @(
        [pscustomobject]@{workspace='mcp-gsc';lastAgentCallAtMs=$now - 20000}
    )
    $refused = $false
    try { AssertFleetQuiet } catch {
        if ($_.Exception.Message -match 'mcp-gsc') { $refused = $true } else { throw }
    }
    if (-not $refused) { throw 'Guard accepted a busy worker' }
    Write-Output 'PASS busy worker is blocked'

    $script:mockChats = @(
        [pscustomobject]@{workspace='mcp-gsc';lastAgentCallAtMs=$now - 240000}
    )
    AssertFleetQuiet
    Write-Output 'PASS completed worker is allowed'

    $script:mockChats = @(
        [pscustomobject]@{workspace='codexify-reliability-lab';lastAgentCallAtMs=$now}
    )
    AssertFleetQuiet
    Write-Output 'PASS updater own diagnostics do not block the service'

    $script:mockFailure = $true
    $refused = $false
    try { AssertFleetQuiet } catch {
        if ($_.Exception.Message -match 'Simulated owner API outage') { $refused = $true } else { throw }
    }
    if (-not $refused) { throw 'Guard accepted an unavailable owner API' }
    Write-Output 'PASS unknown fleet status fails closed'
    if ($script:requested -ne 4) { throw "Unexpected mock API call count $script:requested" }
    Write-Output 'LOCAL_INSTALLER_IDLE_GUARD_TESTS_PASS'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
