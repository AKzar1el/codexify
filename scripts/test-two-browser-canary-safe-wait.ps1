# Isolated canary wait tests; never open a production browser or modify tasks.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot 'install-local-two-browser-upgrade.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer PowerShell syntax is invalid' }
$fn = @($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'WaitForCanaryWindow'
},$true))
if ($fn.Count -ne 1) { throw 'Canary safe-window wait is missing' }
Invoke-Expression $fn[0].Extent.Text
# The extracted install function reads parameters and related predicates that
# normally exist in the installer's script scope. Load their real definitions
# rather than replacing production safeguards with permissive mock stubs.
$ForceMaintenance = $false
foreach ($dependency in @('Test-VerifiedUnsentInitialCreation','Test-VerifiedUnsentFailedAction')) {
    $definition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $dependency
    },$true))
    if ($definition.Count -ne 1) { throw "Canary fixture dependency missing: $dependency" }
    Invoke-Expression $definition[0].Extent.Text
}
$script:statuses = @()
$script:attempts = 0
$script:sleeps = 0
$script:accepted = $false
$script:failedPairing = $false
function SetScenario([string[]]$values,[bool]$sendAccepted=$false,[bool]$badPairing=$false) {
    $script:statuses = @($values)
    $script:attempts = 0
    $script:sleeps = 0
    $script:accepted = $sendAccepted
    $script:failedPairing = $badPairing
}
function ReadVerifiedCanaryState([string]$key) {
    if ($key -ne ('a' * 64)) { throw 'Canary key must be exact' }
    if ($script:failedPairing) { throw 'Canary is not a verified active goal with a reconciled renewal handoff' }
    $idx = [Math]::Min($script:attempts,$script:statuses.Count - 1)
    $script:attempts++
    return [pscustomobject]@{action=[pscustomobject]@{
        status=$script:statuses[$idx];sendAccepted=$script:accepted
    }}
}
function AssertCanaryBelongsToPairedGoal([string]$key) {
    if ($script:accepted) { throw 'Queued canary contains an already accepted Send' }
}
function Start-Sleep {
    [CmdletBinding()]param([int]$Seconds)
    if ($Seconds -lt 1 -or $Seconds -gt 10) { throw "Invalid polling interval $Seconds" }
    $script:sleeps++
}
$key = 'a' * 64
SetScenario @('navigating','sending','generating','queued')
WaitForCanaryWindow $key 1
if ($script:attempts -ne 4 -or $script:sleeps -ne 3) {
    throw 'Did not wait for a transient canary action to become unsent and queued'
}
Write-Output 'PASS navigation, Send and generation wait for an unsent queued state'
SetScenario @('generating','idle')
WaitForCanaryWindow $key 1
if ($script:attempts -ne 2 -or $script:sleeps -ne 1) {
    throw 'Did not wait for generation to resolve to idle'
}
Write-Output 'PASS generating canary may recover to idle'
foreach ($status in @('ambiguous','failed','interference','rate_limited','cancelled','stalled','unknown','')) {
    SetScenario @($status)
    $rejected = $false
    try { WaitForCanaryWindow $key 1 } catch {
        if ($_.Exception.Message -match 'unsafe state') { $rejected=$true } else { throw }
    }
    if (-not $rejected -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
        throw "Unsafe state was waited away or accepted: $status"
    }
}
Write-Output 'PASS ambiguous, failed and unknown canary states fail immediately'
SetScenario @('queued') $true
$rejected = $false
try { WaitForCanaryWindow $key 1 } catch {
    if ($_.Exception.Message -match 'already accepted') { $rejected=$true } else { throw }
}
if (-not $rejected) { throw 'Queued state with accepted Send was allowed' }
Write-Output 'PASS already accepted queued Send remains blocked'
SetScenario @('generating') $false $true
$rejected = $false
try { WaitForCanaryWindow $key 1 } catch {
    if ($_.Exception.Message -match 'verified active goal') { $rejected=$true } else { throw }
}
if (-not $rejected -or $script:sleeps -ne 0) { throw 'Invalid pairing state was waited away' }
Write-Output 'PASS missing ownership/renewal proof fails immediately'
SetScenario @('generating')
$timedOut = $false
try { WaitForCanaryWindow $key 0 } catch {
    if ($_.Exception.Message -match 'no installation started') { $timedOut=$true } else { throw }
}
if (-not $timedOut -or $script:attempts -ne 1 -or $script:sleeps -ne 0) {
    throw 'Canary safe-window deadline was not enforced'
}
Write-Output 'PASS bounded wait expires without starting installation'
$source = Get-Content -LiteralPath $path -Raw
if ($source -notmatch '(?s)if \(\$WaitForCanarySafe\) \{\s*WaitForCanaryWindow \$CanaryTaskKey \$WaitTimeoutMinutes\s*if \(\$PilotPrimaryTaskKey\) \{ WaitForCanaryWindow \$PilotPrimaryTaskKey \$WaitTimeoutMinutes \}\s*AssertReadyForInstall \(Preflight\)') {
    throw 'The initial wait must recheck all installation gates'
}
if ($source -notmatch '(?s)Report .backed_up.*?if \(\$WaitForCanarySafe\) \{\s*WaitForCanaryWindow \$CanaryTaskKey \$WaitTimeoutMinutes\s*if \(\$PilotPrimaryTaskKey\) \{ WaitForCanaryWindow \$PilotPrimaryTaskKey \$WaitTimeoutMinutes \}\s*\}\s*AssertReadyForInstall \(Preflight\)') {
    throw 'The installer must recheck the canary after staging'
}
if ($source -notmatch '(?s)if \(\$still.Count\).*?if \(\$CanaryTaskKey\) \{\s*# The native supervisor is now stopped.*?AssertCanaryBelongsToPairedGoal \$CanaryTaskKey') {
    throw 'Canary state must be verified after stopping the native service'
}
if ($source -notmatch 'elseif \(\$browserStopAttempted\)') {
    throw 'A failed pre-stop wait must not invoke browser start'
}
Write-Output 'PASS pre/post staging and post-shutdown rechecks remain in force'
Write-Output 'CANARY_SAFE_WAIT_TESTS_PASS'
