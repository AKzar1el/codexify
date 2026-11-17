# Read-only Windows audit of two live Codexify browser lanes.
# Never creates browser tabs, follows chat URLs, reads goal prompts, or sends.
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [ValidatePattern('^action-[A-Za-z0-9_-]{8,128}$')][string]$ActionId,
    [ValidateSet(1,2)][int]$ActionLane=2
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function OwnedProcessTree([object[]]$Processes,[int]$RootProcessId) {
    $rootMatches=@($Processes|Where-Object{[int]$_.ProcessId -eq $RootProcessId})
    if($rootMatches.Count -ne 1){throw 'Companion process is missing or not unique'}
    $ids=@($RootProcessId)
    for($depth=0;$depth -lt 25;$depth++){
        $next=@($Processes|Where-Object{
            $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId
        }|Select-Object -ExpandProperty ProcessId)
        if($next.Count -eq 0){return @($Processes|Where-Object{$ids -contains [int]$_.ProcessId})}
        $ids+=$next
    }
    throw 'Process ancestry exceeded the bounded depth'
}
function ProfileMarkers([object[]]$Chrome,[string]$ExpectedProfilePath) {
    $available=0
    $matching=0
    $foreign=0
    foreach($process in $Chrome){
        $command=[string]$process.CommandLine
        if([string]::IsNullOrWhiteSpace($command)){continue}
        $available++
        # A quoted Windows profile path may contain spaces; only parse the
        # actual Chromium argument, never arbitrary text containing its name.
        $match=[regex]::Match($command,'(?i)(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))')
        if($match.Success){
            $actual=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
            try{
                $same=[string]::Equals(
                    [IO.Path]::GetFullPath($actual).TrimEnd('\'),
                    [IO.Path]::GetFullPath($ExpectedProfilePath).TrimEnd('\'),
                    [StringComparison]::OrdinalIgnoreCase)
                if($same){$matching++}else{$foreign++}
            }catch{$foreign++}
        }
    }
    $label=if($foreign -gt 0){'conflicting_profile'}
        elseif($matching -gt 0){'observed_private_profile'}
        else{'command_line_unavailable_or_unproven'}
    [pscustomobject]@{evidence=$label;matching=$matching;available=$available;conflicting=$foreign}
}
function AssertCompletedAction([object]$Snapshot,[object[]]$Events,[string]$ExpectedId) {
    # This proves browser submission, not necessarily a completed model answer.
    # The entire event history is private and only these metadata fields leave.
    if([string]$Snapshot.actionId -cne $ExpectedId -or
        [string]$Snapshot.state -ne 'idle' -or
        $Snapshot.sendAccepted -ne $true -or
        $Snapshot.attention -or
        -not $Snapshot.canonicalUrl){
        throw 'Action snapshot does not prove an accepted, completed browser action'
    }
    $conversation=[Uri]([string]$Snapshot.canonicalUrl)
    if($conversation.Scheme -ne 'https' -or $conversation.Host -ne 'chatgpt.com' -or
        -not $conversation.AbsolutePath.StartsWith('/c/',[StringComparison]::Ordinal)){
        throw 'Action snapshot does not reference a verified ChatGPT conversation'
    }
    if($Events.Count -eq 0 -or [int]$Snapshot.lastEventSequence -ne $Events.Count){
        throw 'Action event history is missing or incomplete'
    }
    $sendSeen=$false
    $terminal=$null
    for($index=0;$index -lt $Events.Count;$index++){
        $event=$Events[$index]
        if([string]$event.actionId -cne $ExpectedId -or
            [int]$event.sequence -ne $index+1){
            throw 'Action event identity or ordering is inconsistent'
        }
        $type=[string]$event.type
        if($type -in @('failed','ambiguous_send','authentication_required','approval_required',
            'external_interference','rate_limited')){
            throw 'Action event history includes an attention or failure event'
        }
        if($type -eq 'send_accepted'){
            if($sendSeen -or $terminal){throw 'Action contains duplicate or late Send'}
            $sendSeen=$true
        }
        if($type -in @('submission_complete','generation_complete')){
            if(-not $sendSeen -or $terminal -or $index -ne $Events.Count-1){
                throw 'Action terminal event occurred without a complete accepted Send'
            }
            $terminal=$type
        }
    }
    if(-not $sendSeen -or -not $terminal){
        throw 'Action lacks Send acceptance or a terminal completion event'
    }
    [pscustomobject]@{
        actionId=$ExpectedId
        actionState='idle'
        sendAccepted=$true
        submissionComplete=($terminal -eq 'submission_complete')
        generationComplete=($terminal -eq 'generation_complete')
        eventCount=$Events.Count
        lastEventSequence=[int]$Snapshot.lastEventSequence
        attentionPresent=$false
    }
}
if($SelfTest){
    $processes=@(
        [pscustomobject]@{ProcessId=10;ParentProcessId=1;Name='codexify-browser-companion.exe';CommandLine=$null},
        [pscustomobject]@{ProcessId=11;ParentProcessId=10;Name='chrome.exe';CommandLine='chrome --user-data-dir=C:\private\one'},
        [pscustomobject]@{ProcessId=20;ParentProcessId=1;Name='codexify-browser-companion.exe';CommandLine=$null},
        [pscustomobject]@{ProcessId=21;ParentProcessId=20;Name='chrome.exe';CommandLine=$null},
        [pscustomobject]@{ProcessId=30;ParentProcessId=1;Name='chrome.exe';CommandLine='chrome --user-data-dir=C:\unrelated'}
    )
    $one=@(OwnedProcessTree $processes 10)
    $two=@(OwnedProcessTree $processes 20)
    if($one.Count -ne 2 -or $two.Count -ne 2 -or
        @($one|Where-Object{$_.ProcessId -eq 30}).Count -or
        @($two|Where-Object{$_.ProcessId -eq 11}).Count){
        throw 'Independent Chrome process-tree isolation failed'
    }
    $known=ProfileMarkers @($one|Where-Object{$_.Name -eq 'chrome.exe'}) 'C:\private\one'
    $unknown=ProfileMarkers @($two|Where-Object{$_.Name -eq 'chrome.exe'}) 'C:\private\two'
    if($known.evidence -ne 'observed_private_profile' -or
        $unknown.evidence -ne 'command_line_unavailable_or_unproven' -or
        $unknown.available -ne 0){
        throw 'Missing process CommandLine was incorrectly treated as a missing browser'
    }
    $foreign=ProfileMarkers @($one|Where-Object{$_.Name -eq 'chrome.exe'}) 'C:\other'
    if($foreign.evidence -ne 'conflicting_profile'){throw 'Profile conflict was not detected'}
    $processes[1].CommandLine='chrome --comment=C:\private\one --user-data-dir=C:\other'
    $spoofed=ProfileMarkers @($processes[1]) 'C:\private\one'
    if($spoofed.evidence -ne 'conflicting_profile'){
        throw 'Non-profile command-line references must not be mistaken for profile evidence'
    }
    $processes[1].CommandLine='chrome --user-data-dir="C:\private\with spaces" --headless'
    $quoted=ProfileMarkers @($processes[1]) 'C:\private\with spaces'
    if($quoted.evidence -ne 'observed_private_profile'){
        throw 'Quoted Windows profile path with spaces was not recognized'
    }
    $processes[1].CommandLine='chrome --not-user-data-dir=C:\private\with-spaces'
    $notARealArgument=ProfileMarkers @($processes[1]) 'C:\private\with-spaces'
    if($notARealArgument.evidence -eq 'observed_private_profile'){
        throw 'Spoofed user-data-dir flag was recognized as Chromium profile evidence'
    }
    $actionId='action-test-receipt-123'
    $snapshot=[pscustomobject]@{actionId=$actionId;state='idle';sendAccepted=$true;
        attention=$null;canonicalUrl='https://chatgpt.com/c/test-receipt';lastEventSequence=3}
    $events=@(
        [pscustomobject]@{actionId=$actionId;sequence=1;type='queued'},
        [pscustomobject]@{actionId=$actionId;sequence=2;type='send_accepted'},
        [pscustomobject]@{actionId=$actionId;sequence=3;type='submission_complete'}
    )
    $receipt=AssertCompletedAction $snapshot $events $actionId
    if(-not $receipt.submissionComplete -or $receipt.generationComplete){
        throw 'Submission completion was incorrectly treated as model generation completion'
    }
    $events[2].sequence=4
    $rejected=$false
    try{[void](AssertCompletedAction $snapshot $events $actionId)}catch{$rejected=$true}
    if(-not $rejected){throw 'Missing event sequence incorrectly passed'}
    $events[2].sequence=3
    $events[2].type='ambiguous_send'
    $rejected=$false
    try{[void](AssertCompletedAction $snapshot $events $actionId)}catch{$rejected=$true}
    if(-not $rejected){throw 'Ambiguous submission incorrectly passed'}
    Write-Output 'TWO_LANE_READ_ONLY_PROBE_TESTS_PASS'
    return
}

$root=Join-Path $env:USERPROFILE '.codexify'
$config=Get-Content -LiteralPath (Join-Path $root 'codexify.config.json') -Raw |ConvertFrom-Json
$automation=$config.agentChat.automation
$descriptorPaths=@(
    (Join-Path $root 'browser\descriptor.json'),
    [string]$automation.lane2DescriptorPath
)
$profilePaths=@(
    (Join-Path $root 'browser\chrome-profile'),
    (Join-Path $root 'browser-lane2-canary\chrome-profile')
)
$all=@(Get-CimInstance Win32_Process)
$lanes=@()
$allBrowserIds=@()
$verifiedReceipt=$null
for($index=0;$index -lt 2;$index++){
    $descriptor=Get-Content -LiteralPath $descriptorPaths[$index] -Raw|ConvertFrom-Json
    $rootId=[int]$descriptor.pid
    $family=@(OwnedProcessTree $all $rootId)
    $head=@($family|Where-Object{[int]$_.ProcessId -eq $rootId})[0]
    if([string]$head.Name -ine 'codexify-browser-companion.exe'){
        throw 'The authenticated descriptor does not point to a browser companion'
    }
    $chrome=@($family|Where-Object{$_.Name -eq 'chrome.exe'})
    $markers=ProfileMarkers $chrome $profilePaths[$index]
    $headers=@{Authorization=('Bearer '+[string]$descriptor.token)}
    $health=Invoke-RestMethod -Uri ($descriptor.endpoint+'/v1/health') -Headers $headers -TimeoutSec 10
    $gate=Invoke-RestMethod -Uri ($descriptor.endpoint+'/v1/send-gate/status') -Headers $headers -TimeoutSec 10
    if($ActionId -and $index -eq $ActionLane-1){
        $actionUri=$descriptor.endpoint.TrimEnd('/')+'/v1/actions/'+[Uri]::EscapeDataString($ActionId)
        $snapshot=Invoke-RestMethod -Uri $actionUri -Headers $headers -TimeoutSec 10
        $stream=Invoke-WebRequest -Uri ($actionUri+'/events?after=0') -Headers $headers -UseBasicParsing -TimeoutSec 15
        # Windows PowerShell 5.1 can return application/x-ndjson as Byte[].
        $body=if($stream.Content -is [byte[]]){
            [Text.Encoding]::UTF8.GetString($stream.Content)
        }else{[string]$stream.Content}
        $events=@($body.Split([char]10)|Where-Object{$_.Trim().StartsWith('{')}|
            ForEach-Object{$_.Trim()|ConvertFrom-Json})
        $verifiedReceipt=AssertCompletedAction $snapshot $events $ActionId
    }
    $lanes+= [pscustomobject]@{
        lane=$index+1
        companionPid=$rootId
        browserProcessCount=$chrome.Count
        chromiumProcessPids=@($chrome|Select-Object -ExpandProperty ProcessId)
        privateProfileDirectoryExists=[bool](Test-Path -LiteralPath $profilePaths[$index] -PathType Container)
        runtimeProfileEvidence=$markers.evidence
        visibleChromeCommands=$markers.available
        matchingProfileCommands=$markers.matching
        conflictingProfileCommands=$markers.conflicting
        companionBuildMatchesDescriptor=([string]$health.build -ceq [string]$descriptor.build)
        authenticated=[bool]$health.authenticated
        companionStatus=[string]$health.status
        activeAction=[bool]$health.activeActionId
        sharedSendGateEnabled=[bool]$gate.enabled
        accountFingerprint=[string]$health.accountFingerprint
        gateFingerprint=[string]$gate.pathFingerprint
    }
    $allBrowserIds+=@($chrome|Select-Object -ExpandProperty ProcessId)
}
$collision=@($allBrowserIds|Group-Object|Where-Object{$_.Count -gt 1}).Count -gt 0
$sameAccount=($lanes[0].authenticated -and $lanes[1].authenticated -and
    $lanes[0].accountFingerprint -and
    $lanes[0].accountFingerprint -ceq $lanes[1].accountFingerprint)
$sameGate=($lanes[0].sharedSendGateEnabled -and $lanes[1].sharedSendGateEnabled -and
    $lanes[0].gateFingerprint -and
    $lanes[0].gateFingerprint -ceq $lanes[1].gateFingerprint)
$report=[pscustomobject]@{
    readOnly=$true
    pilotTaskCount=if($automation.pilotPrimaryTaskKey -and $automation.canaryTaskKey){2}else{0}
    independentChromiumProcesses=($lanes[0].browserProcessCount -gt 0 -and
        $lanes[1].browserProcessCount -gt 0 -and -not $collision)
    sameAuthenticatedAccount=[bool]$sameAccount
    sameEnabledSendGate=[bool]$sameGate
    exactProfileEvidenceAvailable=($lanes[0].runtimeProfileEvidence -eq 'observed_private_profile' -and
        $lanes[1].runtimeProfileEvidence -eq 'observed_private_profile')
    verifiedActionReceipt=$verifiedReceipt
    lanes=@($lanes|ForEach-Object{
        # Do not expose private account fingerprints, gate paths, tokens or
        # private Chrome profile locations in the printed report.
        [pscustomobject]@{
            lane=$_.lane
            companionPid=$_.companionPid
            browserProcessCount=$_.browserProcessCount
            chromiumProcessPids=$_.chromiumProcessPids
            privateProfileDirectoryExists=$_.privateProfileDirectoryExists
            runtimeProfileEvidence=$_.runtimeProfileEvidence
            visibleChromeCommands=$_.visibleChromeCommands
            matchingProfileCommands=$_.matchingProfileCommands
            companionBuildMatchesDescriptor=$_.companionBuildMatchesDescriptor
            authenticated=$_.authenticated
            companionStatus=$_.companionStatus
            activeAction=$_.activeAction
            sharedSendGateEnabled=$_.sharedSendGateEnabled
        }
    })
}
$report|ConvertTo-Json -Depth 6
