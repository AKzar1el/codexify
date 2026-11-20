# Offline contract verification for generated Windows Codexify service scripts.
# This extracts the actual Rust generator functions, compiles only those with
# rustc (not the heavy workspace test target), and executes PowerShell scripts
# against local mocks. It NEVER operates on the real Scheduled Task or processes.
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sourcePath = Join-Path $PSScriptRoot '..\src\service.rs'
$source = [IO.File]::ReadAllText([IO.Path]::GetFullPath($sourcePath))
$functions = @(
  'powershell_quote',
  'windows_stop_script',
  'windows_verify_native_stopped_script',
  'windows_restart_script'
)
$definitions = foreach ($name in $functions) {
  $pattern = if ($name -eq 'windows_verify_native_stopped_script') {
    "(?ms)^fn $name\([^\r\n]*\) -> [^\r\n]+ \{.*?^\x22#\r?\n^\}"
  } else {
    "(?ms)^fn $name\([^\r\n]*\) -> [^\r\n]+ \{.*?^\}"
  }
  $match = [regex]::Match($source, $pattern)
  if (-not $match.Success) {
    throw "Could not isolate source function $name"
  }
  $match.Value
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('codexify-windows-contract-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -Path $root -ItemType Directory -ErrorAction Stop)
try {
  $rust = 'const WINDOWS_TASK: &str = "Codexify";' + [Environment]::NewLine +
    ($definitions -join ([Environment]::NewLine + [Environment]::NewLine)) + [Environment]::NewLine +
    @'
fn main() {
    let output = std::env::args().nth(1).expect("temp path");
    std::fs::write(format!("{output}/stop.ps1"), windows_stop_script()).unwrap();
    std::fs::write(format!("{output}/restart.ps1"), windows_restart_script()).unwrap();
}
'@
  $rustPath = Join-Path $root 'lifecycle.rs'
  [IO.File]::WriteAllText($rustPath, $rust, [Text.UTF8Encoding]::new($false))
  $program = Join-Path $root 'lifecycle.exe'
  $compiler = (Get-Command rustc -ErrorAction Stop).Source
  & $compiler --edition=2021 $rustPath -o $program
  if ($LASTEXITCODE -ne 0) { throw "Isolated rustc compile failed ($LASTEXITCODE)" }
  & $program $root
  if ($LASTEXITCODE -ne 0) { throw "Generator execution failed ($LASTEXITCODE)" }

  $stopText = [IO.File]::ReadAllText((Join-Path $root 'stop.ps1'))
  $restartText = [IO.File]::ReadAllText((Join-Path $root 'restart.ps1'))
  foreach ($name in @('stop','restart')) {
    $path = Join-Path $root "$name.ps1"
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if (@($errors).Count -gt 0) {
      throw ("Generated $name script has syntax errors: " + (@($errors) | ForEach-Object Message) -join '; ')
    }
  }
  Write-Output 'GENERATED_POWERSHELL_PARSE=2/2_PASS'

  # Test-only reduction of the deadline avoids making each mock negative case
  # wait 15 seconds. The actual generated scripts are parsed above unmodified.
  if (-not $stopText.Contains('AddSeconds(15)') -or
      -not $restartText.Contains('AddSeconds(15)')) {
    throw 'Missing source stop timeout'
  }
  $stopText = $stopText.Replace('AddSeconds(15)','AddMilliseconds(30)')
  $restartText = $restartText.Replace('AddSeconds(15)','AddMilliseconds(30)')
  if ($restartText.IndexOf('if ($remainingNative.Count -gt 0)') -gt
      $restartText.IndexOf('Start-ScheduledTask -InputObject $task')) {
    throw 'Restart ordering is unsafe'
  }

  $script:mockState = 'Ready'
  $script:mockNativeRemains = $false
  $script:mockDenyStop = $false
  $script:mockStopped = 0
  $script:mockStarted = 0

  # Local functions shadow the real Windows cmdlets inside this script's scope.
  function Get-ScheduledTask {
    param([string]$TaskName, [string]$ErrorAction)
    if ($TaskName -ne 'Codexify') { throw 'Unexpected task name' }
    [pscustomobject]@{
      State = $script:mockState
      Actions = @([pscustomobject]@{WorkingDirectory='C:\CodexifySyntheticOnly'})
    }
  }
  function Stop-ScheduledTask {
    param($InputObject, [string]$ErrorAction)
    $script:mockStopped++
    if ($script:mockDenyStop) { throw 'Synthetic access denied' }
  }
  function Get-CimInstance {
    param([string]$ClassName, [string]$Filter, [string]$ErrorAction)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected query' }
    if ($script:mockNativeRemains) {
      [pscustomobject]@{ProcessId=4382; ExecutablePath='C:\CodexifySyntheticOnly\bin\codexify.exe'}
    }
  }
  function Start-ScheduledTask {
    param($InputObject, [string]$ErrorAction)
    $script:mockStarted++
  }
  function Start-Sleep { param([int]$Milliseconds) }

  $cases = @(
    @{name='stopped_no_process'; script=$stopText; state='Ready'; residual=$false; deny=$false; stops=0; starts=0; error=$null},
    @{name='running_stop_exits'; script=$stopText; state='Running'; residual=$false; deny=$false; stops=1; starts=0; error=$null},
    @{name='running_stop_orphan'; script=$stopText; state='Running'; residual=$true; deny=$false; stops=1; starts=0; error='native processes remain'},
    @{name='stopped_orphan'; script=$stopText; state='Ready'; residual=$true; deny=$false; stops=0; starts=0; error='native processes remain'},
    @{name='stop_denied'; script=$stopText; state='Running'; residual=$false; deny=$true; stops=1; starts=0; error='Synthetic access denied'},
    @{name='running_restart_exits'; script=$restartText; state='Running'; residual=$false; deny=$false; stops=1; starts=1; error=$null},
    @{name='stopped_restart_exits'; script=$restartText; state='Ready'; residual=$false; deny=$false; stops=0; starts=1; error=$null},
    @{name='restart_orphan_refuses_duplicate'; script=$restartText; state='Running'; residual=$true; deny=$false; stops=1; starts=0; error='native processes remain'},
    @{name='restart_denied_refuses_duplicate'; script=$restartText; state='Running'; residual=$false; deny=$true; stops=1; starts=0; error='Synthetic access denied'}
  )
  $passed = 0
  foreach ($case in $cases) {
    $script:mockState = $case.state
    $script:mockNativeRemains = $case.residual
    $script:mockDenyStop = $case.deny
    $script:mockStopped = 0
    $script:mockStarted = 0
    $caught = $null
    try {
      & ([scriptblock]::Create($case.script)) | Out-Null
    } catch {
      $caught = $_.Exception.Message
    }
    if ($case.error -and (-not $caught -or -not $caught.Contains($case.error))) {
      throw "CASE $($case.name): wanted '$($case.error)', got '$caught'"
    }
    if (-not $case.error -and $caught) {
      throw "CASE $($case.name): unexpected error '$caught'"
    }
    if ($script:mockStopped -ne $case.stops -or $script:mockStarted -ne $case.starts) {
      throw "CASE $($case.name): stop/start $script:mockStopped/$script:mockStarted expected $($case.stops)/$($case.starts)"
    }
    $passed++
    Write-Output "PASS $($case.name)"
  }
  Write-Output "MOCK_CASES=$passed/$($cases.Count) PASS"
  Write-Output 'LIVE_TASK_OR_SERVICE_MUTATIONS=0'
} finally {
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ([IO.Path]::GetFullPath($root).StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($root).StartsWith('codexify-windows-contract-', [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
