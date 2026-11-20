# Deploy only the verified Codexify browser ASAR. Never replace the native service or Chrome profile.
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$receiptPath = Join-Path $project 'artifacts\runtime-patch-ready.json'
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$version = [string]$receipt.version
if ($version -ne '2.4.0') { throw 'Unexpected runtime version' }
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $project 'artifacts')) + [IO.Path]::DirectorySeparatorChar
$candidate = [IO.Path]::GetFullPath([string]$receipt.candidate)
if (-not $candidate.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Candidate is outside verified project artifact root'
}
$resources = Join-Path $env:USERPROFILE ('.codexify\browser\runtime\' + $version + '\app\resources')
$live = Join-Path $resources 'app.asar'
$exe = Join-Path $env:USERPROFILE '.codexify\bin\codexify.exe'
if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or -not (Test-Path -LiteralPath $live -PathType Leaf) -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'Expected candidate, installed archive or CLI missing'
}
function Sha256([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
$beforeSha = Sha256 $live
$wantedSha = [string]$receipt.sha256
if ($beforeSha -ne [string]$receipt.previousSha256 -or (Sha256 $candidate) -ne $wantedSha) {
  throw 'Preimage or candidate hash does not match the verified receipt'
}
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backupDir = Join-Path $env:USERPROFILE ('.codexify\backups\browser-readiness-diagnostic-' + $stamp)
[void](New-Item -ItemType Directory -Path $backupDir)
$backup = Join-Path $backupDir 'app.asar.original'
Copy-Item -LiteralPath $live -Destination $backup -ErrorAction Stop
if ((Sha256 $backup) -ne $beforeSha) { throw 'Rollback archive could not be verified' }
function Invoke-CompanionCommand([string]$verb) {
  if ($verb -notin @('stop','start')) { throw 'Unsupported companion operation' }
  $output = Join-Path $backupDir ($verb + '-stdout.log')
  $errors = Join-Path $backupDir ($verb + '-stderr.log')
  # The companion may inherit stdout from its launcher. Wait for the launcher
  # process, not an open PowerShell pipeline attached to a long-lived browser.
  $process = Start-Process -FilePath $exe -ArgumentList @('browser', $verb) -PassThru -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errors
  if (-not $process.WaitForExit(45000)) { throw ('Companion ' + $verb + ' launcher did not exit') }
  # Some Windows PowerShell process wrappers report a null ExitCode even after
  # WaitForExit succeeds. Subsequent process/hash/HTTP checks prove the result.
  if ($null -ne $process.ExitCode -and [int]$process.ExitCode -ne 0) {
    if ($verb -eq 'start') {
      # A busy but live companion sometimes returns a nonzero launcher status.
      # Accept it only if the *new* private endpoint responds with liveness.
      $descriptorFile = Join-Path $env:USERPROFILE '.codexify\browser\descriptor.json'
      if (Test-Path -LiteralPath $descriptorFile) {
        $descriptor = Get-Content -LiteralPath $descriptorFile -Raw | ConvertFrom-Json
        try {
          $liveness = Invoke-RestMethod -Uri ($descriptor.endpoint.TrimEnd('/') + '/v1/liveness') -Headers @{ Authorization = 'Bearer ' + $descriptor.token } -TimeoutSec 6
          if ($liveness.available -eq $true) { return }
        } catch { }
      }
    }
    throw ('Companion ' + $verb + ' launcher returned a failure')
  }
}
$replaced = $false
$oldDesc = Join-Path $env:USERPROFILE '.codexify\browser\descriptor.json'
$oldPid = $null
if (Test-Path -LiteralPath $oldDesc) {
  $previous = Get-Content -LiteralPath $oldDesc -Raw | ConvertFrom-Json
  $oldPid = $previous.pid
  $health = Invoke-RestMethod -Method Get -Uri ($previous.endpoint.TrimEnd('/') + '/v1/health') -Headers @{ Authorization = 'Bearer ' + $previous.token } -TimeoutSec 8
  if ($health.activeActionId -or @($health.activeActionIds).Count -gt 0) {
    throw 'A browser action is active; companion replacement deferred'
  }
}
Write-Output 'BACKUP_VERIFIED=true'
try {
  Invoke-CompanionCommand 'stop'
  if ($oldPid) {
    for ($i=0;$i -lt 15;$i++) {
      if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { throw 'Old browser companion process did not exit' }
  }
  $staging = Join-Path $resources ('app.asar.staged-' + $stamp)
  Copy-Item -LiteralPath $candidate -Destination $staging -ErrorAction Stop
  if ((Sha256 $staging) -ne $wantedSha) { throw 'Staged archive hash mismatch' }
  $preimageAtomic = Join-Path $backupDir 'app.asar.atomic-original'
  [IO.File]::Replace($staging, $live, $preimageAtomic, $true)
  $replaced = $true
  if ((Sha256 $live) -ne $wantedSha) { throw 'Installed archive verification failed' }
  Invoke-CompanionCommand 'start'
  Start-Sleep -Seconds 3
  $descriptor = Get-Content -LiteralPath $oldDesc -Raw | ConvertFrom-Json
  $headers = @{ Authorization = 'Bearer ' + $descriptor.token }
  $state = Invoke-RestMethod -Method Get -Uri ($descriptor.endpoint.TrimEnd('/') + '/v1/diagnostics/readiness') -Headers $headers -TimeoutSec 8
  Write-Output ('BROWSER_READINESS=' + ($state | ConvertTo-Json -Depth 6 -Compress))
  Write-Output 'INSTALLED_AND_DIAGNOSTIC_VERIFIED=true'
  Write-Output ('ROLLBACK_LOCATION=' + $backupDir)
} catch {
  Write-Output ('ACTIVATION_FAILED=' + $_.Exception.GetType().Name)
  if ($replaced) {
    try {
      Invoke-CompanionCommand 'stop'
      $restore = Join-Path $resources ('app.asar.restore-' + $stamp)
      Copy-Item -LiteralPath $backup -Destination $restore -ErrorAction Stop
      if ((Sha256 $restore) -ne $beforeSha) { throw 'Rollback archive hash mismatch' }
      [IO.File]::Replace($restore, $live, (Join-Path $backupDir 'app.asar.rejected'), $true)
      if ((Sha256 $live) -ne $beforeSha) { throw 'Rollback validation failed' }
      Write-Output 'ROLLBACK_VERIFIED=true'
    } catch { Write-Output ('ROLLBACK_FAILED=' + $_.Exception.GetType().Name) }
  }
  Invoke-CompanionCommand 'start'
  throw
}
