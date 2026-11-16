# Codexify lane-2 companion watchdog. No message Send, account login, or native restart.
# Runs once per invocation; designed for a per-user Windows Scheduled Task.
[CmdletBinding()]
param([switch]$Apply, [switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-SamePath([string]$A,[string]$B) {
    if (-not $A -or -not $B) { return $false }
    try {
        return [string]::Equals(
            [IO.Path]::GetFullPath($A).TrimEnd('\'),
            [IO.Path]::GetFullPath($B).TrimEnd('\'),
            [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}
function Assert-RealPath([string]$Path,[bool]$Directory=$false) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A watchdog runtime/profile path is a reparse point'
    }
    if ($Directory -and -not $item.PSIsContainer) { throw 'Expected a real directory' }
    if (-not $Directory -and $item.PSIsContainer) { throw 'Expected a regular file' }
    return $item
}
function Test-ExactProcess([int]$PidNumber,[string]$ExpectedExe) {
    if ($PidNumber -le 0) { return $false }
    $record=Get-CimInstance Win32_Process -Filter ("ProcessId="+$PidNumber) -ErrorAction SilentlyContinue
    if (-not $record) { return $false }
    return (Test-SamePath ([string]$record.ExecutablePath) $ExpectedExe)
}
function Assert-LocalDescriptor([string]$Path,[string]$ExpectedExe) {
    $item=Assert-RealPath $Path
    if ($item.Length -gt 8192) { throw 'Oversized companion descriptor' }
    $d=Get-Content -LiteralPath $Path -Raw -ErrorAction Stop|ConvertFrom-Json
    if ($null -eq $d.pid -or $null -eq $d.token -or $null -eq $d.endpoint -or $null -eq $d.build) {
        throw 'Incomplete browser companion descriptor'
    }
    $url=[Uri]([string]$d.endpoint)
    if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or
        $url.Port -le 0 -or $url.AbsolutePath -ne '/' -or $url.Query -or $url.Fragment) {
        throw 'Browser companion descriptor does not point to loopback'
    }
    if (-not (Test-ExactProcess ([int]$d.pid) $ExpectedExe)) {
        throw 'Browser companion descriptor PID does not own the expected executable'
    }
    return $d
}
function Read-Proof($Descriptor,[int]$Seconds=5) {
    $headers=@{Authorization=('Bearer '+[string]$Descriptor.token)}
    $health=Invoke-RestMethod -Method Get -Uri ($Descriptor.endpoint+'/v1/health') -Headers $headers -TimeoutSec $Seconds
    $gate=Invoke-RestMethod -Method Get -Uri ($Descriptor.endpoint+'/v1/send-gate/status') -Headers $headers -TimeoutSec $Seconds
    if ($health.build -cne $Descriptor.build -or $gate.build -cne $Descriptor.build) {
        throw 'Browser build differs from authenticated descriptor'
    }
    if (-not $health.authenticated -or [string]::IsNullOrWhiteSpace([string]$health.accountFingerprint) -or
        -not $gate.enabled -or [string]$gate.pathFingerprint -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Companion account or shared Send gate is unverified'
    }
    return [pscustomobject]@{Pid=[int]$Descriptor.pid; Account=[string]$health.accountFingerprint;
        Gate=[string]$gate.pathFingerprint; Status=[string]$health.status; Active=[bool]$health.activeActionId}
}
function Test-CanAttempt([object[]]$Recent,[datetimeoffset]$Now) {
    $hour=@($Recent|Where-Object { $_ -gt $Now.AddHours(-1) }|Sort-Object)
    if ($hour.Count -ge 3) { return $false }
    if ($hour.Count -gt 0 -and $hour[-1] -gt $Now.AddSeconds(-90)) { return $false }
    return $true
}
if ($SelfTest) {
    if (-not (Test-SamePath 'C:\Apps\Companion.exe' 'c:\apps\COMPANION.EXE')) { throw 'Case-insensitive path comparison failed' }
    if (Test-SamePath 'C:\Apps\Companion.exe' 'C:\Apps\Other.exe') { throw 'Executable identity confusion' }
    if (Test-ExactProcess -PidNumber -1 -ExpectedExe 'C:\Nope.exe') { throw 'Invalid PID accepted' }
    if (Test-ExactProcess -PidNumber $PID -ExpectedExe 'C:\Apps\codexify-browser-companion.exe') {
        throw 'An unrelated live process was mistaken for the companion'
    }
    $now=[datetimeoffset]::UtcNow
    if (-not (Test-CanAttempt @() $now)) { throw 'Fresh watchdog attempt blocked' }
    if (Test-CanAttempt @($now.AddMinutes(-2),$now.AddMinutes(-3),$now.AddMinutes(-4)) $now) { throw 'Crash loop admitted' }
    if (Test-CanAttempt @($now.AddSeconds(-10)) $now) { throw 'Rapid relaunch admitted' }
    if (Test-CanAttempt @($now.AddSeconds(-10),$now.AddMinutes(-10)) $now) {
        throw 'Unsorted attempts bypassed the recent-launch cutoff'
    }
    if (-not (Test-CanAttempt @($now.AddHours(-2)) $now)) { throw 'Expired crash window not reset' }
    Write-Output 'LANE2_WATCHDOG_SELFTEST_PASS'
    return
}
$root=Join-Path $env:USERPROFILE '.codexify'
$lane=Join-Path $root 'browser-lane2-canary'
$profile=Join-Path $lane 'chrome-profile'
$descriptorPath=Join-Path $lane 'descriptor.json'
$primaryPath=Join-Path $root 'browser\descriptor.json'
$configPath=Join-Path $root 'codexify.config.json'
$manifestPath=Join-Path $root 'browser\runtime\2.3.29\manifest.json'
$runtime=Split-Path -Parent $manifestPath
$exe=Join-Path $runtime 'app\codexify-browser-companion.exe'
$statePath=Join-Path $lane 'watchdog-state.json'
$lockPath=Join-Path $lane 'watchdog.lock'
foreach($dir in @($root,$lane,$profile,$runtime,(Split-Path -Parent $exe))) {
    [void](Assert-RealPath $dir $true)
}
foreach($file in @($configPath,$manifestPath,$exe,$primaryPath)) {
    [void](Assert-RealPath $file)
}
$lock=$null
if ($Apply) {
    # FileShare.None protects against two periodic invocations racing to launch.
    try {
        $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    } catch [IO.IOException] {
        Write-Output 'LANE2_WATCHDOG_ALREADY_RUNNING'
        return
    }
}
$recent=@()
function Save-Result([string]$Status,[string]$Reason='',[int]$NewPid=0) {
    $message=('LANE2_WATCHDOG '+$Status+' '+$Reason).Trim()
    Write-Output $message
    if (-not $Apply) { return }
    $record=[ordered]@{
        version=1;checkedAt=[DateTimeOffset]::UtcNow.ToString('o')
        status=$Status;reason=$Reason;recentStarts=@($script:recent|ForEach-Object{$_.ToString('o')})
        lastLaunchedPid=$NewPid
    }
    $tmp=Join-Path $lane ('watchdog-state.'+[Guid]::NewGuid().ToString('N')+'.tmp')
    try {
        $record|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $statePath -Force
    } finally { if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force} }
}
try {
    if (Test-Path -LiteralPath $statePath) {
        [void](Assert-RealPath $statePath)
        $saved=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
        foreach($stamp in @($saved.recentStarts)){
            if (-not $stamp) { continue }
            $when=[DateTimeOffset]::Parse([string]$stamp)
            if ($when -gt [DateTimeOffset]::UtcNow.AddHours(-1)) { $recent+=@($when) }
        }
    }
    $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
    $a=$config.agentChat.automation
    if (-not $a -or -not $a.canaryTaskKey -or -not $a.pilotPrimaryTaskKey -or
        [string]$a.canaryTaskKey -eq [string]$a.pilotPrimaryTaskKey -or
        [string]$a.canaryTaskKey -cnotmatch '^[a-f0-9]{64}$' -or
        [string]$a.pilotPrimaryTaskKey -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Exactly two distinct configured pilot task keys are required'
    }
    if ($a.lane2DescriptorPath -and -not (Test-SamePath ([string]$a.lane2DescriptorPath) $descriptorPath)) {
        throw 'Native lane-2 descriptor binding changed'
    }
    if ((Get-ScheduledTask -TaskName 'Codexify' -ErrorAction Stop).State -ne 'Running') {
        Save-Result 'deferred' 'native_task_not_running'; return
    }
    try {
        $native=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 5
    } catch { Save-Result 'deferred' 'native_unavailable'; return }
    if ($native.status -ne 'ok') { Save-Result 'deferred' 'native_unhealthy'; return }
    $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
    $primary=Assert-LocalDescriptor $primaryPath $exe
    if ([string]$primary.build -cne [string]$manifest.build) { throw 'Primary build no longer matches installed browser runtime' }
    $primaryProof=Read-Proof $primary
    $gate=[string]$a.providerSendGatePath
    if (-not [IO.Path]::IsPathRooted($gate)) { throw 'Configured provider Send gate is not absolute' }
    $sha=[Security.Cryptography.SHA256]::Create()
    try {$gateFingerprint=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($gate))).Replace('-','').ToLowerInvariant()}
    finally {$sha.Dispose()}
    if ($gateFingerprint -cne $primaryProof.Gate) { throw 'Configured provider Send gate differs from primary companion' }

    if (Test-Path -LiteralPath $descriptorPath) {
        try {
            $secondary=Assert-LocalDescriptor $descriptorPath $exe
            $secondaryProof=Read-Proof $secondary
            if ([string]$secondary.build -cne [string]$manifest.build -or
                $secondaryProof.Pid -eq $primaryProof.Pid -or
                $secondaryProof.Account -cne $primaryProof.Account -or
                $secondaryProof.Gate -cne $primaryProof.Gate) {
                throw 'Secondary has unverified account, build or Send gate'
            }
            Save-Result 'healthy' 'secondary_verified'; return
        } catch {
            $d=Get-Content -LiteralPath $descriptorPath -Raw|ConvertFrom-Json
            if ($d.pid -and (Test-ExactProcess ([int]$d.pid) $exe)) {
                Save-Result 'blocked' 'existing_secondary_process_unhealthy'; return
            }
            # Stale descriptor: only safe to continue if no other unmatched
            # companion is alive; never trust PID alone (PID reuse).
        }
    }
    if (Test-Path -LiteralPath $lockPath) { } # This is our per-invocation lock, not the provider Send gate.
    if (Test-Path -LiteralPath $gate) {
        Save-Result 'deferred' 'provider_send_gate_busy'; return
    }
    $all=@(Get-CimInstance Win32_Process -Filter "Name='codexify-browser-companion.exe'")
    $primaryFamily=@([int]$primary.pid)
    for($depth=0;$depth -lt 6;$depth++) {
        $children=@($all|Where-Object{$primaryFamily -contains [int]$_.ParentProcessId}|Select-Object -ExpandProperty ProcessId)
        $primaryFamily+=@($children|Where-Object{$_ -notin $primaryFamily})
    }
    $other=@($all|Where-Object{($_.ProcessId -notin $primaryFamily) -and (Test-SamePath ([string]$_.ExecutablePath) $exe)})
    if ($other.Count -gt 0) { Save-Result 'blocked' 'unidentified_companion_process'; return }
    $chrome=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($chrome.Count -gt 0) { Save-Result 'blocked' 'secondary_profile_in_use'; return }
    if (-not (Test-CanAttempt $recent ([DateTimeOffset]::UtcNow))) {
        Save-Result 'deferred' 'crash_loop_backoff'; return
    }
    $os=Get-CimInstance Win32_OperatingSystem
    if (($os.FreePhysicalMemory / 1048576) -lt 1.5) {
        Save-Result 'deferred' 'insufficient_memory'; return
    }
    if (-not $Apply) { Save-Result 'would_restore' 'verified_missing_companion'; return }
    # Last short guard before spawning: no other watchdog and no secondary browser.
    if (Test-Path -LiteralPath $descriptorPath) {
        $recheck=Get-Content -LiteralPath $descriptorPath -Raw|ConvertFrom-Json
        if ($recheck.pid -and (Test-ExactProcess ([int]$recheck.pid) $exe)) {
            Save-Result 'blocked' 'secondary_appeared_before_start'; return
        }
    }
    $recent+=@([DateTimeOffset]::UtcNow)
    Save-Result 'launching' 'confirmed_missing_secondary'
    $psi=New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName=$exe
    $psi.WorkingDirectory=$runtime
    $psi.UseShellExecute=$false
    $psi.CreateNoWindow=$true
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_HOME']=$lane
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_DESCRIPTOR']=$descriptorPath
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_BUILD']=[string]$manifest.build
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_SEND_GATE_PATH']=$gate
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_REQUEST_BLOCK_LIST']='[]'
    $psi.EnvironmentVariables['CODEXIFY_BROWSER_NAVIGATION_TIMINGS']=(ConvertTo-Json -InputObject $a.retryTimings -Compress -Depth 4)
    $child=[Diagnostics.Process]::Start($psi)
    if (-not $child) { throw 'Installed browser companion failed to launch' }
    $until=(Get-Date).AddSeconds(50)
    while ((Get-Date) -lt $until) {
        Start-Sleep -Seconds 2
        if ($child.HasExited) { Save-Result 'failed' 'companion_exited_early' $child.Id; return }
        if (-not (Test-Path -LiteralPath $descriptorPath)) { continue }
        try {
            $d=Assert-LocalDescriptor $descriptorPath $exe
            if ([int]$d.pid -ne $child.Id) { continue }
            $proof=Read-Proof $d 4
            if ($proof.Account -cne $primaryProof.Account -or $proof.Gate -cne $primaryProof.Gate -or
                [string]$d.build -cne [string]$manifest.build) {
                Save-Result 'blocked' 'restarted_profile_or_gate_mismatch' $child.Id
                return
            }
            Save-Result 'restored' 'existing_profile_verified' $child.Id
            return
        } catch {}
    }
    Save-Result 'blocked' 'started_but_authentication_unverified' $child.Id
} catch {
    Save-Result 'blocked' $_.Exception.Message
    throw
} finally {
    if ($lock) { $lock.Dispose() }
}
