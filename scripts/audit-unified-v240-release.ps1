# Read-only validation of a locally built, version-matched native/Chrome release.
# Does not stop, restart, install or modify any Codexify process/profile.
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$ArchiveOnly,
    [string]$ArchivePath,
    [string]$NativeBinaryPath,
    [string]$SchemaPath,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version='2.4.0'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -AssemblyName 'System.IO.Compression'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'

function VerifyArchive([string]$path,[string]$version,[string]$protocolHash) {
    $source=Get-Item -LiteralPath $path -ErrorAction Stop
    if(-not $source -or $source.PSIsContainer -or $source.Length -gt 805306368 -or
        $source.Length -le 0 -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw 'Archive must be a bounded regular file, not a link'
    }
    $rootName="codexify-browser-v$version-windows-x64/"
    $archive=[IO.Compression.ZipFile]::OpenRead($source.FullName)
    try {
        if($archive.Entries.Count -gt 100000){throw 'Too many archive entries'}
        $found=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        [long]$expanded=0
        $manifestEntry=$null
        $entrypointEntry=$null
        $chromePresent=$false
        foreach($entry in $archive.Entries){
            $name=[string]$entry.FullName
            if(-not $name.StartsWith($rootName,[StringComparison]::Ordinal) -or
                $name.Contains('\') -or $name.StartsWith('/') -or
                $name -match '(^|/)\.\.?(/|$)|:' -or $name.Contains([char]0) -or
                -not $found.Add($name)){
                throw 'Archive contains duplicate or unsafe paths'
            }
            $kind=([long]$entry.ExternalAttributes -shr 16) -band 61440
            if($kind -eq 40960){throw 'Archive contains a symbolic link'}
            if($entry.Length -gt 536870912 -or $entry.CompressedLength -gt 536870912){
                throw 'Archive entry size exceeds safety ceiling'
            }
            $expanded += [long]$entry.Length
            if($expanded -gt 1610612736){throw 'Archive expanded size exceeds safety ceiling'}
            if($name -ceq ($rootName+'manifest.json')){$manifestEntry=$entry}
            if($name -match '/resources/chrome/chromium-[0-9]+/.*/chrome.exe$'){$chromePresent=$true}
        }
        if(-not $manifestEntry -or $manifestEntry.Length -gt 65536){throw 'Archive manifest missing or oversized'}
        $reader=[IO.StreamReader]::new($manifestEntry.Open(),[Text.Encoding]::UTF8)
        try {$manifest=($reader.ReadToEnd()|ConvertFrom-Json -ErrorAction Stop)} finally {$reader.Dispose()}
        $expectedBuild=$version+'+protocol.'+$protocolHash
        if([int]$manifest.version -ne 1 -or
            [string]$manifest.codexifyVersion -cne $version -or
            [int]$manifest.protocolVersion -ne 1 -or
            [string]$manifest.protocolSchemaHash -cne $protocolHash -or
            [string]$manifest.build -cne $expectedBuild -or
            [string]$manifest.platform -cne 'windows-x64'){
            throw 'Archive manifest does not match native/protocol build'
        }
        $entrypoint=[string]$manifest.entrypoint
        if(-not $entrypoint.StartsWith('app/',[StringComparison]::Ordinal) -or
            $entrypoint -match '(^|/)\.\.?(/|$)|\\|:'){
            throw 'Archive manifest entrypoint is unsafe'
        }
        $entrypointEntry=$archive.GetEntry($rootName+$entrypoint)
        if(-not $entrypointEntry -or $entrypointEntry.Length -le 0 -or -not $chromePresent){
            throw 'Packaged executable or Chromium runtime is missing'
        }
        [pscustomobject]@{
            packageVersion=$version
            platform='windows-x64'
            browserProtocolVersion=1
            browserBuild=$expectedBuild
            archiveSha256=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            expandedBytes=$expanded
            entries=$archive.Entries.Count
            entrypointVerified=$true
            chromiumVerified=$true
        }
    } finally {$archive.Dispose()}
}

if($SelfTest){
    $tmp=Join-Path $env:TEMP ('unified-release-verify-'+[guid]::NewGuid().ToString('N'))
    [void](New-Item -Path $tmp -ItemType Directory)
    try{
        $schema=[Text.Encoding]::UTF8.GetBytes('{"test":true}')
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$protocol=([BitConverter]::ToString($sha.ComputeHash($schema))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        $zipPath=Join-Path $tmp 'fixture.zip'
        $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
        try{
            $prefix='codexify-browser-v2.4.0-windows-x64/'
            $records=@{
                'manifest.json'=@{version=1;codexifyVersion='2.4.0';protocolVersion=1;protocolSchemaHash=$protocol;build=('2.4.0+protocol.'+$protocol);platform='windows-x64';entrypoint='app/test.exe'}|ConvertTo-Json -Compress
                'app/test.exe'='fixture'
                'app/resources/chrome/chromium-123/chrome-win64/chrome.exe'='fixture'
            }
            foreach($key in $records.Keys){
                $entry=$zip.CreateEntry($prefix+$key)
                $writer=[IO.StreamWriter]::new($entry.Open())
                try{$writer.Write([string]$records[$key])}finally{$writer.Dispose()}
            }
        }finally{$zip.Dispose()}
        $good=VerifyArchive $zipPath '2.4.0' $protocol
        if(-not $good.entrypointVerified -or -not $good.chromiumVerified){throw 'Valid fixture failed'}
        $rejected=$false
        try{[void](VerifyArchive $zipPath '2.4.0' ('0'*64))}catch{$rejected=$true}
        if(-not $rejected){throw 'Mismatched protocol erroneously accepted'}
        $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Update)
        try{
            $entry=$zip.CreateEntry($prefix+'../../evil.txt')
            $writer=[IO.StreamWriter]::new($entry.Open())
            try{$writer.Write('blocked')}finally{$writer.Dispose()}
        }finally{$zip.Dispose()}
        $rejected=$false
        try{[void](VerifyArchive $zipPath '2.4.0' $protocol)}catch{$rejected=$true}
        if(-not $rejected){throw 'Traversal fixture erroneously accepted'}
        Write-Output 'UNIFIED_RELEASE_READ_ONLY_FIXTURES_PASS'
    } finally {Remove-Item -LiteralPath $tmp -Force -Recurse -ErrorAction SilentlyContinue}
    return
}
if(-not $ArchivePath -or -not $SchemaPath -or (-not $ArchiveOnly -and -not $NativeBinaryPath)){
    throw 'ArchivePath and SchemaPath, plus NativeBinaryPath unless ArchiveOnly, are required'
}
$schema=Get-Item -LiteralPath $SchemaPath -ErrorAction Stop
if($schema.PSIsContainer -or ($schema.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw 'Protocol schema must be a regular file'
}
$hash=(Get-FileHash -LiteralPath $schema.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$package=VerifyArchive $ArchivePath $Version $hash
if($ArchiveOnly){
    $package|Add-Member -NotePropertyName nativeVersionVerified -NotePropertyValue $false
}else{
    $native=Get-Item -LiteralPath $NativeBinaryPath -ErrorAction Stop
    if($native.PSIsContainer -or ($native.Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw 'Native executable must be a regular file'
    }
    # Codexify does not implement --version. Doctor is read-only and emits
    # the compile-time version even when optional diagnostics are unhealthy.
    $raw=(& $native.FullName doctor --json 2>$null |Out-String).Trim()
    if(-not $raw){throw 'Native doctor version report is unavailable'}
    $doctor=$raw|ConvertFrom-Json -ErrorAction Stop
    if([string]$doctor.version -cne $Version){
        throw 'Native executable version does not match the package'
    }
    $package|Add-Member -NotePropertyName nativeSha256 -NotePropertyValue ((Get-FileHash -LiteralPath $native.FullName -Algorithm SHA256).Hash.ToLowerInvariant())
    $package|Add-Member -NotePropertyName nativeVersionVerified -NotePropertyValue $true
}
$package|Add-Member -NotePropertyName readOnly -NotePropertyValue $true
# Matching artifacts alone do not mean a service maintenance window is safe.
$package|Add-Member -NotePropertyName safeToInstall -NotePropertyValue $false
$package|ConvertTo-Json -Depth 3