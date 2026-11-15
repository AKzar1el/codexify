# Verifies stale-process recovery using mocks only: NEVER touches a real PID.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Installer PowerShell failed to parse' }
$definition = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'WaitForVerifiedServiceProcessesExit'
}, $true))
if ($definition.Count -ne 1) { throw 'Expected exactly one service-process cleanup function' }
Invoke-Expression $definition[0].Extent.Text

$root = 'C:\TwoBrowserOrphanTest'
$target = Join-Path $root 'bin\codexify.exe'
$config = Join-Path $root 'codexify.config.json'
$script:baseline = [datetime]'2026-11-15T21:00:00Z'
$script:scenario = 'normal'
$script:stopped = @()
$script:reports = @()
$script:rows = @()
function NewService([int]$id, [string]$role) {
    $cmd = if ($role -eq 'supervisor') { '"' + $target + '" service run --config "' + $config + '"' }
           else { '"' + $target + '" --config ' + $config }
    return [pscustomobject]@{
        ProcessId = $id; ExecutablePath = $target; CommandLine = $cmd
        CreationDate = $script:baseline
    }
}
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected live CIM query' }
    if ($Filter) {
        $id = [int]($Filter -replace '[^0-9]', '')
        $match = @($script:rows | Where-Object { $_.ProcessId -eq $id })
        if (-not $match.Count) { return $null }
        $row = $match[0]
        if ($script:scenario -eq 'vanished') {
            $script:rows = @($script:rows | Where-Object { $_.ProcessId -ne $id })
            return $null
        }
        if ($script:scenario -eq 'reused_unrelated_executable') {
            $script:rows = @($script:rows | Where-Object { $_.ProcessId -ne $id })
            return [pscustomobject]@{
                ProcessId=$id;ExecutablePath='C:\Windows\System32\other.exe'
                CommandLine='other.exe';CreationDate=$script:baseline.AddMinutes(1)
            }
        }
        if ($script:scenario -eq 'reused_same_command') {
            return [pscustomobject]@{
                ProcessId=$id;ExecutablePath=$target;CommandLine=$row.CommandLine
                CreationDate=$script:baseline.AddMinutes(1)
            }
        }
        if ($script:scenario -eq 'changed_command') {
            return [pscustomobject]@{
                ProcessId=$id;ExecutablePath=$target
                CommandLine=('"' + $target + '" doctor')
                CreationDate=$script:baseline
            }
        }
        return $row
    }
    return $script:rows
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    if (-not $Force) { throw 'Unexpected non-force process stop' }
    $script:stopped += $Id
    $script:rows = @($script:rows | Where-Object { $_.ProcessId -ne $Id })
}
function Start-Sleep { [CmdletBinding()] param([int]$Seconds) }
function Report { param([string]$state, [string]$detail) $script:reports += $state }
function ResetCase([string]$mode) {
    $script:scenario = $mode
    $script:rows = @((NewService 11188 'supervisor'))
    $script:stopped = @()
    $script:reports = @()
}

ResetCase 'normal'
$script:rows += (NewService 7904 'worker')
WaitForVerifiedServiceProcessesExit
if ($script:rows.Count -ne 0 -or $script:stopped.Count -ne 2) {
    throw 'Two stable verified service processes were not released'
}
Write-Output 'PASS stable service orphan processes released'

ResetCase 'reused_unrelated_executable'
WaitForVerifiedServiceProcessesExit
if ($script:stopped.Count -ne 0 -or $script:rows.Count -ne 0) {
    throw 'An unrelated replacement PID was terminated or blocked despite old service exit'
}
Write-Output 'PASS unrelated reused PID never terminated'

ResetCase 'vanished'
WaitForVerifiedServiceProcessesExit
if ($script:stopped.Count -ne 0 -or $script:rows.Count -ne 0) {
    throw 'Vanished PID was terminated or blocked'
}
Write-Output 'PASS process exiting during inspection is ignored safely'

foreach ($mode in @('changed_command','reused_same_command')) {
    ResetCase $mode
    $blocked = $false
    try { WaitForVerifiedServiceProcessesExit } catch {
        if ($_.Exception.Message -match '(still in use|changed during inspection)') { $blocked = $true }
        else { throw }
    }
    if (-not $blocked -or $script:stopped.Count -ne 0) {
        throw "Unresolved PID identity $mode was killed or permitted"
    }
    Write-Output "PASS unresolved $mode blocks update without termination"
}
Write-Output 'TWO_BROWSER_ORPHAN_RACE_TESTS_PASS'
