# Enrol a token for a dedicated Playwright automation Chrome profile.
# Stores the token only in an ACL-restricted file outside the Git repository.
# Does not modify Codexify configuration or launch a browser.
param(
    [switch]$Apply,
    [switch]$Rotate,
    [string]$DedicatedProfile = ''
)
$ErrorActionPreference='Stop'
$root=Join-Path $env:USERPROFILE '.codexify'
$configPath=Join-Path $root 'codexify.config.json'
$secretDir=Join-Path $root 'secrets\playwright-extension'
$secretPath=Join-Path $secretDir 'connection-token.txt'
if(-not (Test-Path -LiteralPath $configPath -PathType Leaf)){throw 'Codexify config missing'}
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
$server=$config.mcpServers.'playwright-extension'
if(-not $server){throw 'playwright-extension source not configured'}
if(-not @($server.args|Where-Object {$_ -eq '--extension' -or $_ -eq '--extension=true'}).Count){throw 'Selected MCP source is not extension mode'}
$profile=[string]$server.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME
if(-not $profile -or $profile -eq 'Default'){throw 'A dedicated non-default Chrome profile must be explicitly configured'}
if($Apply -and $DedicatedProfile -ne $profile){throw 'Explicit -DedicatedProfile must match configured dedicated profile'}
if($Rotate -and -not $Apply){throw '-Rotate requires -Apply'}
Write-Output ('Dedicated Chrome profile: '+$profile)
Write-Output ('Enrolment already exists: '+[bool](Test-Path -LiteralPath $secretPath))
if(-not $Apply){
    Write-Output 'DRY RUN ONLY. No secrets stored, no browser started, no configuration changes.'
    Write-Output ('To opt in later: powershell.exe -NoProfile -File "'+$PSCommandPath+'" -Apply -DedicatedProfile "'+$profile+'"')
    return
}
if((Test-Path -LiteralPath $secretPath) -and -not $Rotate){throw 'Token already stored; use -Rotate only when explicitly replacing it'}
if($Rotate -and -not (Test-Path -LiteralPath $secretPath)){throw 'Cannot rotate an absent token'}
$inputToken=Read-Host 'Paste the token from Playwright Extension in this DEDICATED profile' -AsSecureString
if(-not $inputToken){throw 'No token supplied'}
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($inputToken)
try { $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if($token -notmatch '^[A-Za-z0-9_-]{16,512}$'){throw 'Unexpected Playwright token format; no file written'}
if(-not(Test-Path -LiteralPath $secretDir -PathType Container)){
    [void](New-Item -ItemType Directory -Path $secretDir -Force)
}
# Remove inherited ACLs and grant only the current Windows account plus
# SYSTEM and Administrators. Never widen access to Users or Everyone.
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$account=New-Object Security.Principal.NTAccount($identity.Name)
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($account)
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$prop=[Security.AccessControl.PropagationFlags]::None
$allow=[Security.AccessControl.AccessControlType]::Allow
foreach($who in @($account,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($who,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow)
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $secretDir -AclObject $acl -ErrorAction Stop
$tmp=Join-Path $secretDir ('.connection-token-'+[Guid]::NewGuid().ToString('N')+'.pending')
$backup=$null
$committed=$false
try{
    [IO.File]::WriteAllText($tmp,$token,[Text.Encoding]::ASCII)
    $token=$null
    if((Get-Item -LiteralPath $tmp).Length -lt 16){throw 'Token staging failed'}
    if($Rotate){
        $backup=Join-Path $secretDir ('old-token-'+[Guid]::NewGuid().ToString('N')+'.pending')
        Move-Item -LiteralPath $secretPath -Destination $backup -ErrorAction Stop
    }
    Move-Item -LiteralPath $tmp -Destination $secretPath -ErrorAction Stop
    $committed=$true
}finally{
    $token=$null
    if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}
    if($backup -and (Test-Path -LiteralPath $backup)){
        if(-not $committed -and -not (Test-Path -LiteralPath $secretPath)){
            Move-Item -LiteralPath $backup -Destination $secretPath -ErrorAction Stop
        }elseif($committed){
            Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
        }
    }
}
Write-Output 'Token stored in Windows user-restricted directory. Token value not printed.'
Write-Output ('To use after deploying a COMPATIBLE Codexify candidate, set mcpServers.playwright-extension.sessionScope=per-chat and env.PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE to '+$secretPath)
Write-Output 'Existing live configuration and browser remain unchanged.'