# Regression for the local updater's orphan-service cleanup.
# All process APIs are mocked: this test never stops a real process.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$path = Join-Path $PSScriptRoot 'install-local-updater-fix.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Installer PowerShell does not parse' }
$definition = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'WaitForVerifiedServiceProcessesExit'
}, $true))
if ($definition.Count -ne 1) { throw 'Expected exactly one orphan-process function' }
Invoke-Expression $definition[0].Extent.Text

$root = 'C:\CodexifyTest'
$target = Join-Path $root 'bin\codexify.exe'
$config = Join-Path $root 'codexify.config.json'
$script:processes = @()
$script:stopped = @()
$script:reusedPid = $false

function Get-CimInstance {
    [CmdletBinding()]
    param([string]$Class, [string]$Filter)
    if ($Class -ne 'Win32_Process') { throw 'Unexpected process query' }
    if ($Filter) {
        $id = [int]($Filter -replace '[^0-9]', '')
        $match = @($script:processes | Where-Object { $_.ProcessId -eq $id })
        if ($script:reusedPid -and $match.Count -gt 0) {
            return [pscustomobject]@{
                ProcessId = $id
                ExecutablePath = $target
                CommandLine = ('"' + $target + '" doctor')
            }
        }
        return ($match | Select-Object -First 1)
    }
    return $script:processes
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    if (-not $Force) { throw 'Unforced process stop' }
    $script:stopped += $Id
    $script:processes = @($script:processes | Where-Object { $_.ProcessId -ne $Id })
}
function Start-Sleep {
    [CmdletBinding()]
    param([int]$Seconds)
}
function Report {
    param([string]$State, [string]$Detail)
}

$service = [pscustomobject]@{
    ProcessId = 21588
    ExecutablePath = $target
    CommandLine = ('"' + $target + '" service run --config "' + $config + '"')
}
$child = [pscustomobject]@{
    ProcessId = 6952
    ExecutablePath = $target
    CommandLine = ('"' + $target + '" --config ' + $config)
}
$other = [pscustomobject]@{
    ProcessId = 44551
    ExecutablePath = $target
    CommandLine = ('"' + $target + '" doctor')
}

# A task-disabled service can leave both verified processes behind.
$script:processes = @($service, $child)
WaitForVerifiedServiceProcessesExit
if ($script:processes.Count -ne 0 -or
    @($script:stopped | Sort-Object).Count -ne 2 -or
    @($script:stopped | Where-Object { $_ -notin @(21588, 6952) }).Count -ne 0) {
    throw 'Verified service cleanup did not stop precisely both orphan PIDs'
}

# An unrelated CLI process using the same installed executable must block
# cleanup, without stopping the valid service process first.
$script:processes = @($service, $other)
$script:stopped = @()
try {
    WaitForVerifiedServiceProcessesExit
    throw 'Unexpected acceptance of unrelated Codexify CLI process'
} catch {
    if ($_.Exception.Message -notmatch 'not a verified service process') { throw }
}
if ($script:stopped.Count -ne 0) { throw 'Stopped a process despite unverified peer' }

# A reused PID must be rejected at the second process inspection.
$script:processes = @($service)
$script:reusedPid = $true
try {
    WaitForVerifiedServiceProcessesExit
    throw 'Unexpected acceptance of changed PID command line'
} catch {
    if ($_.Exception.Message -notmatch 'changed during inspection') { throw }
}
if ($script:stopped.Count -ne 0) { throw 'Stopped a reused process ID' }

$script:reusedPid = $false
$script:processes = @()
WaitForVerifiedServiceProcessesExit
Write-Output 'LOCAL_UPDATER_MOCKED_ORPHAN_TESTS_PASS'
