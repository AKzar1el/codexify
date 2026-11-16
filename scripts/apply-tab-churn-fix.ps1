# Installs only the previously staged tab-churn fix through the guarded
# Codexify updater, preserving the independently signed-in lane-2 profile.
# Run in independent elevated PowerShell, never the live Codexify MCP tunnel.
[CmdletBinding()]
param([switch]$Apply,[switch]$ForceMaintenance)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.codexify'
$native = Join-Path $root 'bin\codexify.exe'
$runtime = Join-Path $root 'browser\runtime\2.3.29'
$exe = Join-Path $runtime 'app\codexify-browser-companion.exe'
$installedAsar = Join-Path $runtime 'app\resources\app.asar'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$candidate = Join-Path $repo 'browser-companion\release\win-unpacked\resources\app.asar'
$installer = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$primaryDescriptor = Join-Path $root 'browser\descriptor.json'
$secondaryRoot = Join-Path $root 'browser-lane2-canary'
$secondaryDescriptor = Join-Path $secondaryRoot 'descriptor.json'
$config = Get-Content -LiteralPath (Join-Path $root 'codexify.config.json') -Raw | ConvertFrom-Json
$gate = [string]$config.agentChat.automation.providerSendGatePath
if ($config.agentChat.automation.PSObject.Properties['canaryTaskKey'] -and
    [bool]$config.agentChat.automation.canaryTaskKey) {
    throw 'Canary routing is already enabled; use the pool-aware updater instead'
}
if (-not [IO.Path]::IsPathRooted($gate)) { throw 'No absolute shared Send admission gate is configured' }
foreach ($path in @($native,$exe,$installedAsar,$candidate,$secondaryDescriptor,$primaryDescriptor,$installer)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing required runtime file: $path" }
}
function BrowserProof([string]$descriptor) {
    $d=Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
    $uri=[Uri]$d.endpoint
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or
        -not (Get-Process -Id $d.pid -ErrorAction SilentlyContinue)) {
        throw 'Browser descriptor is not backed by a live localhost companion'
    }
    $headers=@{Authorization=('Bearer '+$d.token)}
    $h=Invoke-RestMethod -Uri ($d.endpoint+'/v1/health') -Headers $headers -TimeoutSec 12
    $g=Invoke-RestMethod -Uri ($d.endpoint+'/v1/send-gate/status') -Headers $headers -TimeoutSec 12
    if (-not $h.authenticated -or -not $h.accountFingerprint -or -not $g.enabled -or
        [string]$g.pathFingerprint -notmatch '^[0-9a-f]{64}$') {
        throw 'Browser account or shared Send gate is not authenticated/valid'
    }
    return [pscustomobject]@{Pid=[int]$d.pid;Account=[string]$h.accountFingerprint;
        Gate=[string]$g.pathFingerprint;Status=[string]$h.status;Active=[bool]$h.activeActionId}
}
$primary=BrowserProof $primaryDescriptor
$secondary=BrowserProof $secondaryDescriptor
if ($primary.Pid -eq $secondary.Pid -or $primary.Account -cne $secondary.Account -or
    $primary.Gate -cne $secondary.Gate) { throw 'The two companions do not share one verified account/Send gate' }
if ($secondary.Status -ne 'idle' -or $secondary.Active) {
    throw 'The secondary companion has an active browser action; refusing to interrupt it'
}
if ((Get-FileHash $native -Algorithm SHA256).Hash -ne
    (Get-FileHash (Join-Path $repo 'target\debug\codexify.exe') -Algorithm SHA256).Hash) {
    throw 'Native binary differs from the proven build; this helper handles browser-only changes'
}
if ((Get-FileHash $candidate -Algorithm SHA256).Hash -eq
    (Get-FileHash $installedAsar -Algorithm SHA256).Hash) {
    throw 'No new browser bundle to install'
}
if (-not (Test-Path (Join-Path $secondaryRoot 'chrome-profile') -PathType Container)) {
    throw 'Existing secondary isolated profile is missing'
}
Write-Output 'TWO_BROWSERS_VERIFIED_IDENTICAL_ACCOUNT_AND_SEND_GATE'
Write-Output 'SECONDARY_CONFIRMED_IDLE'
Write-Output 'BROWSER_PATCH_STAGED_AND_DIFFERS_FROM_PRODUCTION'
if (-not $Apply) { Write-Output 'READ_ONLY_PREFLIGHT_OK'; return }
if (-not $ForceMaintenance) { throw 'Apply requires explicit -ForceMaintenance acknowledgment' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer in independent Administrator PowerShell'
}
if (Test-Path -LiteralPath (Join-Path $root 'browser-pool\send.lock')) {
    throw 'Send admission lock is currently held; do not interrupt an uncertain accepted Send'
}
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($secondary.Pid)"
if (-not $process -or -not $process.ExecutablePath -or
    -not [string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath),
        [IO.Path]::GetFullPath($exe),[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Secondary process identity changed, refusing a targeted stop'
}
$stopped=$false
$installSucceeded=$false
$installFailure=$null
try {
    # The secondary does no work while the single-task canary is disabled.
    # Terminate only this independently verified process tree before replacing
    # a shared Electron archive that Windows might otherwise keep open.
    $kill=Join-Path $env:windir 'System32\taskkill.exe'
    & $kill /PID $secondary.Pid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the idle secondary companion' }
    $stopped=$true
    $until=(Get-Date).AddSeconds(20)
    while ((Get-Process -Id $secondary.Pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $until) {
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $secondary.Pid -ErrorAction SilentlyContinue) {
        throw 'Secondary browser process did not stop; refusing to replace in-use browser bundle'
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Apply -ForceMaintenance
    if ($LASTEXITCODE -ne 0) { throw 'Guarded release installer did not verify success' }
    $installSucceeded=$true
} catch {
    $installFailure=$_.Exception.Message
} finally {
    if ($stopped) {
        try {
            $manifest=Get-Content -LiteralPath (Join-Path $runtime 'manifest.json') -Raw|ConvertFrom-Json
            $psi=New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName=$exe
            $psi.WorkingDirectory=$runtime
            $psi.UseShellExecute=$false
            $psi.CreateNoWindow=$true
            $psi.EnvironmentVariables['CODEXIFY_BROWSER_HOME']=$secondaryRoot
            $psi.EnvironmentVariables['CODEXIFY_BROWSER_DESCRIPTOR']=$secondaryDescriptor
            $psi.EnvironmentVariables['CODEXIFY_BROWSER_BUILD']=[string]$manifest.build
            $psi.EnvironmentVariables['CODEXIFY_BROWSER_SEND_GATE_PATH']=$gate
            $blockRules=@()
            if ($config.agentChat.automation.PSObject.Properties['requestBlockingEnabled'] -and
                $config.agentChat.automation.requestBlockingEnabled -and
                $config.agentChat.automation.PSObject.Properties['requestBlockList']) {
                $blockRules=@($config.agentChat.automation.requestBlockList)
            }
            $psi.EnvironmentVariables['CODEXIFY_BROWSER_REQUEST_BLOCK_LIST']=ConvertTo-Json -InputObject $blockRules -Compress -Depth 5
            $settings=$null
            if ($config.agentChat.automation.PSObject.Properties['retryTimings']) {
                $settings=$config.agentChat.automation.retryTimings
            }
            if ($null -ne $settings) {
                $psi.EnvironmentVariables['CODEXIFY_BROWSER_NAVIGATION_TIMINGS']=ConvertTo-Json -InputObject $settings -Compress -Depth 5
            }
            $processNew=[System.Diagnostics.Process]::Start($psi)
            if (-not $processNew) { throw 'Could not relaunch the secondary companion' }
            $deadline=(Get-Date).AddSeconds(60)
            $restored=$false
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 2
                try {
                    $recovered=BrowserProof $secondaryDescriptor
                    if ($recovered.Pid -eq $processNew.Id -and $recovered.Account -eq $primary.Account -and
                        $recovered.Gate -eq $primary.Gate) { $restored=$true; break }
                } catch {}
            }
            if (-not $restored) { throw 'Secondary browser relaunch/authentication failed; inspect lane2 profile without cloning credentials' }
            Write-Output 'SECONDARY_COMPANION_RESTORED_VERIFIED'
        } catch { Write-Warning ('Secondary companion restore needs attention: '+$_.Exception.Message) }
    }
}
if ($installFailure) { throw ('Browser patch installation failed: '+$installFailure) }
if (-not $installSucceeded) { throw 'Browser patch was not verified' }
if ((Get-FileHash $candidate -Algorithm SHA256).Hash -ne
    (Get-FileHash $installedAsar -Algorithm SHA256).Hash) {
    throw 'Installed browser bundle checksum does not match staged candidate'
}
Write-Output 'BROWSER_TAB_CHURN_FIX_INSTALLED'
Write-Output 'SECOND_LANE_TASK_ROUTING_STILL_DISABLED_UNTIL_PAIRED_CANARY'
