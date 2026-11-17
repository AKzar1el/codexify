# Called only by install-local-two-browser-upgrade.ps1 from an independent,
# elevated maintenance shell after the native service has been disabled.
# Retires/relaunches the exact paired secondary Electron/Chromium tree.
# Never alters a Chrome profile, a goal record, or a Send receipt.
[CmdletBinding()]
param(
    [ValidateSet('Stop','Start')][string]$Phase = 'Stop',
    [switch]$Apply,
    [switch]$SelfTest,
    [string]$ExpectedAccount,
    [string]$ExpectedGate
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function SamePath([string]$A,[string]$B) {
    if (-not $A -or -not $B) { return $false }
    try {
        return [string]::Equals([IO.Path]::GetFullPath($A),[IO.Path]::GetFullPath($B),
            [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}
function UnderPath([string]$A,[string]$Parent) {
    if (-not $A -or -not $Parent) { return $false }
    try {
        return [IO.Path]::GetFullPath($A).StartsWith(
            [IO.Path]::GetFullPath($Parent).TrimEnd('\')+'\',
            [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}
function ManagedFamily([object[]]$Processes,[int]$RootPid) {
    $family = @($RootPid)
    for ($depth=0; $depth -lt 20; $depth++) {
        $children = @($Processes | Where-Object {
            $family -contains [int]$_.ParentProcessId -and
            $family -notcontains [int]$_.ProcessId
        } | Select-Object -ExpandProperty ProcessId)
        if ($children.Count -eq 0) { return @($Processes | Where-Object { $family -contains [int]$_.ProcessId }) }
        $family += $children
    }
    throw 'Companion process ancestry is unexpectedly deep; refusing to stop any PID'
}
function AssertManagedFamily([object[]]$Family,[string]$ExpectedExe,[string]$ChromeRoot,[int]$RootPid) {
    if (@($Family | Where-Object { [int]$_.ProcessId -eq $RootPid }).Count -ne 1) {
        throw 'Secondary root process is not uniquely identified'
    }
    foreach ($process in $Family) {
        if ($process.Name -ieq 'codexify-browser-companion.exe') {
            if (-not (SamePath ([string]$process.ExecutablePath) $ExpectedExe)) {
                throw 'Secondary family includes a companion from another executable'
            }
        } elseif ($process.Name -ieq 'chrome.exe') {
            if (-not (UnderPath ([string]$process.ExecutablePath) $ChromeRoot)) {
                throw 'Secondary family includes Chrome from an unrelated runtime'
            }
        } else {
            throw ('Secondary family includes an unrecognized process: '+[string]$process.Name)
        }
    }
}
if ($SelfTest) {
    # This maintenance script runs under Windows PowerShell 5.1. Case-insensitive
    # automatic variables such as $PID and $PROFILE must never be declared as
    # parameters or assigned to, even with different capitalization.
    $parsedTokens=$null
    $parseErrors=$null
    $scriptAst=[Management.Automation.Language.Parser]::ParseFile(
        $PSCommandPath,[ref]$parsedTokens,[ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'Secondary maintenance self-test found a parser error' }
    $automaticNames=@('PID','PROFILE','HOME','HOST','INPUT','ERROR','ARGS',
        'MATCHES','NULL','TRUE','FALSE','PWD','PSHOME','LASTEXITCODE',
        'PSBoundParameters','PSCmdlet','MyInvocation')
    $writes=@($scriptAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -in $automaticNames
    },$true))
    $badParameters=@($scriptAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.ParameterAst] -and
        $node.Name.VariablePath.UserPath -in $automaticNames
    },$true))
    if ($writes.Count -or $badParameters.Count) {
        throw 'Secondary maintenance assigns or binds a reserved PowerShell automatic variable'
    }
    # Execute the real Stop helper's parameter binding with a fake process
    # lookup. This would have caught the $pid binding failure before the
    # updater interrupted any workers. No process can be killed in this test.
    $stopDefinition=@($scriptAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'StopVerifiedProcessTree'
    },$true))
    if ($stopDefinition.Count -ne 1) { throw 'StopVerifiedProcessTree function missing' }
    Invoke-Expression $stopDefinition[0].Extent.Text
    $script:fakeProcessLookups=0
    function Get-CimInstance {
        [CmdletBinding()]
        param([string]$ClassName,[string]$Filter)
        $script:fakeProcessLookups++
        return $null
    }
    $safelyRejected=$false
    try { StopVerifiedProcessTree -CompanionProcessId 12345 } catch {
        if ($_.Exception.Message -eq 'Secondary launcher PID no longer owns the exact executable') {
            $safelyRejected=$true
        } else { throw }
    }
    if (-not $safelyRejected -or $script:fakeProcessLookups -ne 1) {
        throw 'Secondary Stop parameter binding or initial identity guard failed'
    }
    $exe = 'C:\managed\app\codexify-browser-companion.exe'
    $chrome = 'C:\managed\app\resources\chrome'
    $fake = @(
        [pscustomobject]@{Name='codexify-browser-companion.exe';ProcessId=100;ParentProcessId=2;ExecutablePath=$exe},
        [pscustomobject]@{Name='codexify-browser-companion.exe';ProcessId=101;ParentProcessId=100;ExecutablePath=$exe},
        [pscustomobject]@{Name='chrome.exe';ProcessId=102;ParentProcessId=100;ExecutablePath='C:\managed\app\resources\chrome\chrome.exe'},
        [pscustomobject]@{Name='chrome.exe';ProcessId=103;ParentProcessId=102;ExecutablePath='C:\managed\app\resources\chrome\chrome.exe'},
        [pscustomobject]@{Name='chrome.exe';ProcessId=104;ParentProcessId=998;ExecutablePath='C:\other\chrome.exe'}
    )
    $family = @(ManagedFamily $fake 100)
    AssertManagedFamily $family $exe $chrome 100
    if ($family.Count -ne 4) { throw 'Process-tree isolation incorrectly claimed unrelated Chrome' }
    $fake[2].ExecutablePath = 'C:\other\chrome.exe'
    $rejected=$false
    try { AssertManagedFamily (ManagedFamily $fake 100) $exe $chrome 100 } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unrelated Chrome passed the family guard' }
    $fake[2].ExecutablePath = 'C:\managed\app\resources\chrome\chrome.exe'
    $fake[1].Name = 'powershell.exe'
    $rejected=$false
    try { AssertManagedFamily (ManagedFamily $fake 100) $exe $chrome 100 } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unrelated helper process passed the family guard' }
    Write-Output 'SECONDARY_PROCESS_TREE_GUARDS_PASS'
    return
}
if (-not $Apply -or $ExpectedAccount -notmatch '^[a-f0-9]{64}$' -or
    $ExpectedGate -notmatch '^[a-f0-9]{64}$') {
    throw 'Explicit Apply and verified secondary account/gate fingerprints are required'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Secondary maintenance requires Administrator PowerShell'
}
$task=Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop
if ($task.State -eq 'Running' -or $task.Settings.Enabled) {
    throw 'The native supervisor must be stopped and disabled first'
}
$root=Join-Path $env:USERPROFILE '.codexify'
$lane=Join-Path $root 'browser-lane2-canary'
$descriptorPath=Join-Path $lane 'descriptor.json'
$laneProfilePath=Join-Path $lane 'chrome-profile'
$config=Get-Content -LiteralPath (Join-Path $root 'codexify.config.json') -Raw | ConvertFrom-Json
$automation=$config.agentChat.automation
$manifestPath=Join-Path $root 'browser\runtime\2.3.29\manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runtime=Split-Path -Parent $manifestPath
$exe=Join-Path $runtime 'app\codexify-browser-companion.exe'
$chromeRoot=Join-Path $runtime 'app\resources\chrome'
$gate=[string]$automation.providerSendGatePath
if (-not (SamePath $gate (Join-Path $root 'browser-pool\send.lock')) -or
    -not (SamePath ([string]$automation.lane2DescriptorPath) $descriptorPath)) {
    throw 'Secondary descriptor or shared Send gate changed'
}
if (Test-Path -LiteralPath $gate) { throw 'Provider Send lock exists: refusing maintenance' }
$sha=[Security.Cryptography.SHA256]::Create()
try {
    $fingerprint=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($gate)))).Replace('-','').ToLowerInvariant()
} finally { $sha.Dispose() }
if ($fingerprint -cne $ExpectedGate) { throw 'Send gate fingerprint changed' }
foreach($path in @($lane,$laneProfilePath,$runtime,(Split-Path -Parent $exe),$chromeRoot)) {
    $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A managed browser path is not an ordinary directory'
    }
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Secondary companion executable missing' }
function ReadDescriptor {
    $file=Get-Item -LiteralPath $descriptorPath -Force -ErrorAction Stop
    if ($file.Length -gt 8192 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Secondary descriptor is not a small regular file'
    }
    $d=Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    $url=[Uri]([string]$d.endpoint)
    if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/' -or
        [string]$d.build -cne [string]$manifest.build -or [int]$d.pid -le 0 -or -not $d.token) {
        throw 'Secondary descriptor identity is not verified'
    }
    return $d
}
function ProfileChrome {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($laneProfilePath,[StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}
function Proof($descriptor) {
    $headers=@{Authorization=('Bearer '+[string]$descriptor.token)}
    $h=Invoke-RestMethod -Uri ($descriptor.endpoint+'/v1/health') -Headers $headers -TimeoutSec 7
    $g=Invoke-RestMethod -Uri ($descriptor.endpoint+'/v1/send-gate/status') -Headers $headers -TimeoutSec 7
    if (-not $h.authenticated -or [string]$h.accountFingerprint -cne $ExpectedAccount -or
        -not $g.enabled -or [string]$g.pathFingerprint -cne $ExpectedGate -or
        [string]$h.build -cne [string]$descriptor.build) {
        throw 'Secondary companion account, build or Send gate is not verified'
    }
    return [pscustomobject]@{Active=[bool]$h.activeActionId;Idle=([string]$h.status -eq 'idle')}
}
function StopVerifiedProcessTree([int]$CompanionProcessId) {
    # Never use $pid as a local/parameter: it collides with PowerShell's
    # case-insensitive, read-only $PID automatic variable.
    $before=Get-CimInstance Win32_Process -Filter ('ProcessId='+$CompanionProcessId) -ErrorAction Stop
    if (-not $before -or -not (SamePath ([string]$before.ExecutablePath) $exe)) {
        throw 'Secondary launcher PID no longer owns the exact executable'
    }
    $all=@(Get-CimInstance Win32_Process)
    $family=@(ManagedFamily $all $CompanionProcessId)
    AssertManagedFamily $family $exe $chromeRoot $CompanionProcessId
    $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$CompanionProcessId) -ErrorAction Stop
    if (-not $current -or -not (SamePath ([string]$current.ExecutablePath) $exe) -or
        [datetime]$current.CreationDate -ne [datetime]$before.CreationDate) {
        throw 'Secondary root PID changed identity before shutdown'
    }
    # Windows taskkill /T terminates only this verified descendant tree. The
    # separate primary companion and unrelated desktop Chrome are excluded.
    $tool=Join-Path $env:SystemRoot 'System32\taskkill.exe'
    & $tool /PID $CompanionProcessId /T /F | Out-Null
    for($attempt=0;$attempt -lt 16;$attempt++){
        Start-Sleep -Milliseconds 500
        $left=@(Get-CimInstance Win32_Process | Where-Object { $family.ProcessId -contains $_.ProcessId })
        if ($left.Count -eq 0 -and @(ProfileChrome).Count -eq 0) { return }
    }
    throw 'Secondary process family or private Chrome profile is still active'
}
if ($Phase -eq 'Stop') {
    $d=ReadDescriptor
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$d.pid) -ErrorAction Stop
    if (-not $process -or -not (SamePath ([string]$process.ExecutablePath) $exe)) {
        throw 'Secondary descriptor references a missing or unrelated process'
    }
    $timestamp=[DateTimeOffset]::Parse([string]$d.createdAt)
    if ([math]::Abs((([DateTimeOffset]$process.CreationDate)-$timestamp).TotalMinutes) -gt 2) {
        throw 'Secondary descriptor PID creation timestamp does not match process'
    }
    $proof=Proof $d
    if ($proof.Active -or -not $proof.Idle) {
        throw 'Secondary is not verified idle; an uncertain active Send must not be interrupted'
    }
    StopVerifiedProcessTree ([int]$d.pid)
    Write-Output 'SECONDARY_VERIFIED_PROCESS_TREE_STOPPED'
    return
}
if ($Phase -eq 'Start') {
    if ((Test-Path -LiteralPath $descriptorPath)) {
        $previous=Get-Content -LiteralPath $descriptorPath -Raw|ConvertFrom-Json
        if ($previous.pid -and (Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$previous.pid) -ErrorAction SilentlyContinue)) {
            throw 'Secondary descriptor already has a live PID; refusing duplicate browser'
        }
    }
    if (@(ProfileChrome).Count -gt 0) {
        throw 'The secondary private Chrome profile is already in use'
    }
    $psi=[Diagnostics.ProcessStartInfo]::new()
    $psi.FileName=$exe
    $psi.WorkingDirectory=$runtime
    $psi.UseShellExecute=$false
    $psi.CreateNoWindow=$true
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_HOME']=$lane
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_DESCRIPTOR']=$descriptorPath
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_BUILD']=[string]$manifest.build
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_SEND_GATE_PATH']=$gate
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_REQUEST_BLOCK_LIST']='[]'
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_NAVIGATION_TIMINGS']=(ConvertTo-Json -InputObject $automation.retryTimings -Depth 4 -Compress)
    $child=[Diagnostics.Process]::Start($psi)
    if (-not $child) { throw 'Secondary browser could not be launched' }
    for($attempt=0;$attempt -lt 45;$attempt++){
        Start-Sleep -Seconds 2
        if ($child.HasExited) { throw 'Secondary browser exited before verification' }
        try {
            $d=ReadDescriptor
            if ([int]$d.pid -ne $child.Id) { continue }
            $proof=Proof $d
            if ($proof.Idle -and -not $proof.Active) {
                Write-Output 'SECONDARY_VERIFIED_EXISTING_PROFILE_RESTARTED'
                return
            }
        } catch {}
    }
    # The service is still disabled, so no goal could be dispatched by this
    # installer. Clean up only this exact launcher after a startup failure.
    try { StopVerifiedProcessTree ([int]$child.Id) } catch {}
    throw 'Secondary browser did not authenticate using its existing profile'
}
