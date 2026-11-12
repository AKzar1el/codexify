# Isolated PowerShell regression for the updater's Windows port-owner guard.
# All socket, process, and sleep commands below are mocked. No live process
# can be stopped, even when the source fixture enters the orphan branch.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path $PSScriptRoot -Parent
$source = Get-Content -LiteralPath (Join-Path $root 'src/self_update.rs') -Raw
$pattern = 'fn windows_service_port_guard_script\(\) -> &''static str \{\s*r#"(?<code>.*?)"#'
$match = [regex]::Match($source, $pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $match.Success) { throw 'Unable to extract the generated Windows port guard' }

Invoke-Expression $match.Groups['code'].Value

$ServicePort = 49999
$Target = 'C:\Tools\Codexify\codexify.exe'
$script:listenerPresent = $true
$script:ownerPath = 'C:\Tools\Codexify\codexify.exe'
$script:ownerCommand = '"C:\Tools\Codexify\codexify.exe" --config C:\Tools\Codexify\codexify.config.json'
$script:stopped = @()
$script:logged = @()

function Get-NetTCPConnection {
    [CmdletBinding()]
    param([string] $State)
    if ($State -ne 'Listen') { throw 'Unexpected socket probe' }
    if ($script:listenerPresent) { [pscustomobject]@{LocalPort = 49999; OwningProcess = 44044} }
}
function Get-CimInstance {
    [CmdletBinding()]
    param([string] $Class, [string] $Filter)
    if ($Class -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 44044') {
        throw 'Unexpected process lookup'
    }
    [pscustomobject]@{ExecutablePath = $script:ownerPath; CommandLine = $script:ownerCommand}
}
function Stop-Process {
    [CmdletBinding()]
    param([int] $Id, [switch] $Force)
    if ($Id -ne 44044 -or -not $Force) { throw 'Unexpected simulated stop' }
    $script:stopped += $Id
    $script:listenerPresent = $false
}
function Start-Sleep {
    [CmdletBinding()]
    param([int] $Seconds, [int] $Milliseconds)
}
function Write-UpdateLog {
    param([string] $Message)
    $script:logged += $Message
}

# A different executable on the same port is never touched.
$script:ownerPath = 'C:\Windows\System32\notepad.exe'
try {
    Wait-VerifiedServicePortRelease
    throw 'Unexpected acceptance of unrelated listener'
} catch {
    if ($_.Exception.Message -notmatch 'unverified process') { throw }
}
if ($script:stopped.Count -ne 0) { throw 'An unrelated process was stopped' }

# Even the expected executable must have a matching service command line.
$script:ownerPath = $Target
$script:ownerCommand = '"C:\Tools\Codexify\codexify.exe" --help'
try {
    Wait-VerifiedServicePortRelease
    throw 'Unexpected acceptance of non-service command'
} catch {
    if ($_.Exception.Message -notmatch 'unverified process') { throw }
}
if ($script:stopped.Count -ne 0) { throw 'A non-service command was stopped' }

# Exactly one verified orphaned Codexify listener can be released.
$script:ownerCommand = '"C:\Tools\Codexify\codexify.exe" --config C:\Tools\Codexify\codexify.config.json'
Wait-VerifiedServicePortRelease
if ($script:stopped.Count -ne 1 -or $script:stopped[0] -ne 44044 -or $script:listenerPresent) {
    throw 'Verified orphan recovery did not release exactly the intended listener'
}

# No process should be touched when the port is already free.
$script:stopped = @()
Wait-VerifiedServicePortRelease
if ($script:stopped.Count -ne 0) { throw 'Free-port case stopped a process' }
Write-Output 'WINDOWS_UPDATER_PORT_GUARD_TESTS_PASS'
