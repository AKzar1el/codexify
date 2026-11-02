# Manually run by the owner, not by a scheduled Research Shot worker.
# Installs two opt-in MCP research tools; never reinstalls Codexify or restarts it.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$lf=[string][char]10
$crlf=([string][char]13)+$lf
$utf8=New-Object System.Text.UTF8Encoding($false)
$base=Join-Path $env:USERPROFILE '.codexify'
$side=Join-Path $base 'revenue-shot-direct-v041'
$server=Join-Path $side 'server.mjs'
$module=Join-Path $side 'fleet-research-inbox.mjs'
$projects=Join-Path $side 'projects.json'
$config=Join-Path $base 'codexify.config.json'
$inbox=Join-Path $base 'revenue-shot-research'
$commit='5bd436ebf5604f0172e1e9700b6284c92611a965'
$previousCommit='00007e8dc375c3fffc53fc84c80b976393a6eaf3'
$uri='https://raw.githubusercontent.com/AKzar1el/codexify/'+$commit+'/scripts/fleet-research-inbox.mjs'
$node=(Get-Command node -ErrorAction Stop).Source

foreach($file in @($server,$projects,$config,(Join-Path $inbox 'tasks.json'))){
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw ('EXPECTED_FILE_MISSING: '+$file)}
}
$queue=Get-Content -LiteralPath (Join-Path $inbox 'tasks.json') -Raw | ConvertFrom-Json
if($queue.version -ne 1 -or $null -eq $queue.items){throw 'QUEUE_STATE_INVALID'}
function ReplaceOnce([string]$s,[string]$needle,[string]$value,[string]$label){
  $first=$s.IndexOf($needle,[System.StringComparison]::Ordinal)
  if($first -lt 0){throw ('INSTALL_SOURCE_CHANGED: '+$label)}
  if($s.IndexOf($needle,$first+$needle.Length,[System.StringComparison]::Ordinal) -ge 0){
    throw ('INSTALL_AMBIGUOUS_ANCHOR: '+$label)
  }
  return $s.Replace($needle,$value)
}
$original=[System.IO.File]::ReadAllText($server)
$usesCrLf=$original.Contains($crlf)
$text=$original.Replace($crlf,$lf)
$integrated=$text.Contains('import { createResearchInbox }')
if(!$integrated){
  $anchor='import { createFleetWorktreeInitializer } from "./fleet-worktree-init.mjs";'
  $text=ReplaceOnce $text $anchor ($anchor+$lf+
    'import { createResearchInbox } from "./fleet-research-inbox.mjs";') 'import'
  $declarations=@'
  if(config.enableResearchInbox===true){
    const researchProject={type:"string",
      enum:["geo","godprompt","gsc","nofax","trendpulse","webvalidator"]
        .filter(p=>Object.hasOwn(config.projects,p))};
    list.push(tool("read_research_tasks",
      "Read-only snapshot of the shared fixed-root research task queue; no project files or journals modified.",
      {project:researchProject},[],readOnly));
    const line={type:"string",minLength:12,maxLength:700};
    list.push(tool("propose_research_task",
      "WRITE APPROVAL REQUIRED: Submit one concrete, evidence-backed proposal to a bounded shared tasks.txt queue. Never execute code, change project sources, write journals, or approve implementation.",
      {project:researchProject,
       issue_key:{type:"string",pattern:"^[a-z][a-z0-9-]{3,79}$"},
       run_key:{type:"string",pattern:"^[A-Za-z0-9_.:+-]{8,160}$"},
       priority:{type:"string",enum:["P0","P1","P2","P3"]},
       confidence:{type:"string",enum:["HIGH","MEDIUM"]},
       title:{...line,maxLength:120},
       problem:line,impact:{...line,maxLength:400},
       action:line,validation:{...line,maxLength:600},
       evidence:{type:"array",items:{type:"string",minLength:12,maxLength:500},
         minItems:1,maxItems:4}},
      ["project","issue_key","run_key","priority","confidence",
       "title","problem","impact","action","validation","evidence"],
      {readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}));
  }
'@
  $needle='  return list;'+$lf+'}'+$lf+'export function makeHandler(config) {'
  $replacement=$declarations.TrimEnd()+$lf+$needle
  $text=ReplaceOnce $text $needle $replacement 'tool-catalog'
  $anchor='    ...createScopedWorktreeActions(config), ...createFleetWorktreeInitializer(config) };'
  $replacement='    ...createScopedWorktreeActions(config), ...createFleetWorktreeInitializer(config),'+
    $lf+'    ...createResearchInbox(config) };'
  $text=ReplaceOnce $text $anchor $replacement 'service'
}
elseif(!$text.Contains('propose_research_task') -or !$text.Contains('...createResearchInbox(config)')){
  throw 'PARTIALLY_INSTALLED_SERVER_REQUIRES_REVIEW'
}
# Existing V1 sidecars already define the reader; extend it in-place for
# exact issue-key lookup without disturbing unrelated native tools.
$oldReadSchema='      {project:researchProject},[],readOnly));'
$newReadSchema=@'
      {project:researchProject,
       issue_key:{type:"string",pattern:"^[a-z][a-z0-9-]{3,79}$"},
       query:{type:"string",minLength:3,maxLength:100},
       limit:{type:"integer",minimum:1,maximum:100}},[],readOnly));
'@
$newReadSchema=$newReadSchema.TrimEnd()
if($text.Contains($oldReadSchema)){
  $text=ReplaceOnce $text $oldReadSchema $newReadSchema 'research-reader-search'
}
elseif(!$text.Contains('limit:{type:"integer",minimum:1,maximum:100}')){
  throw 'RESEARCH_READER_SCHEMA_NOT_RECOGNIZED'
}
if($usesCrLf){$text=$text.Replace($lf,$crlf)}
$pc=Get-Content -LiteralPath $projects -Raw | ConvertFrom-Json
$pc|Add-Member -NotePropertyName enableResearchInbox -NotePropertyValue $true -Force
$pc|Add-Member -NotePropertyName researchInboxRoot -NotePropertyValue $inbox -Force
$newProjects=$pc|ConvertTo-Json -Depth 80
$gc=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json
if(!$gc.mcpServers -or !$gc.mcpServers.revenue_shot_preflight){throw 'BRIDGE_NOT_CONFIGURED'}
$bridge=$gc.mcpServers.revenue_shot_preflight
if($null -eq $bridge.tools){throw 'BRIDGE_TOOL_LIST_MISSING'}
$tools=@($bridge.tools)
foreach($name in @('read_research_tasks','propose_research_task')){
  if($tools -notcontains $name){$tools+=$name}
}
$bridge.tools=$tools
$newConfig=$gc|ConvertTo-Json -Depth 80
$stage=Join-Path $env:TEMP ('research-inbox-install-'+[guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($stage)|Out-Null
try{
  $download=Join-Path $stage 'fleet-research-inbox.mjs'
  Invoke-WebRequest -Uri $uri -UseBasicParsing -OutFile $download
  & $node --check $download
  if($LASTEXITCODE -ne 0){throw 'MODULE_SYNTAX_INVALID'}
  $candidate=Join-Path $stage 'server.mjs'
  [System.IO.File]::WriteAllText($candidate,$text,$utf8)
  & $node --check $candidate
  if($LASTEXITCODE -ne 0){throw 'SERVER_SYNTAX_INVALID'}
  $moduleExisted=Test-Path -LiteralPath $module -PathType Leaf
  if($moduleExisted){
    $installedHash=(Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash
    $newHash=(Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
    if($installedHash -ne $newHash){
      $baseline=Join-Path $stage 'previous-research-inbox.mjs'
      $priorUri='https://raw.githubusercontent.com/AKzar1el/codexify/'+
        $previousCommit+'/scripts/fleet-research-inbox.mjs'
      Invoke-WebRequest -Uri $priorUri -UseBasicParsing -OutFile $baseline
      if($installedHash -ne (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash){
        throw 'EXISTING_MODULE_NOT_KNOWN_BASELINE_REVIEW_REQUIRED'
      }
    }
  }
  if(!$Apply){
    Write-Output 'Preflight verified. Re-run this script with -Apply to install.'
    exit 0
  }
  foreach($file in @($server,$projects,$config)){
    if((Get-Item -LiteralPath $file -Force).Attributes.ToString().Contains('ReparsePoint')){
      throw ('CONFIG_LINK_UNSAFE: '+$file)
    }
  }
  $snapshot=@{}
  foreach($file in @($server,$projects,$config)){
    $snapshot[$file]=(Get-FileHash -LiteralPath $file).Hash
  }
  $backup=Join-Path $base ('maintenance\research-inbox-install-'+
    (Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6))
  [System.IO.Directory]::CreateDirectory($backup)|Out-Null
  Copy-Item -LiteralPath $server -Destination (Join-Path $backup 'server.mjs')
  Copy-Item -LiteralPath $projects -Destination (Join-Path $backup 'projects.json')
  Copy-Item -LiteralPath $config -Destination (Join-Path $backup 'codexify.config.json')
  if($moduleExisted){Copy-Item -LiteralPath $module -Destination (Join-Path $backup 'fleet-research-inbox.mjs')}
  foreach($file in @($server,$projects,$config)){
    if((Get-FileHash -LiteralPath $file).Hash -ne $snapshot[$file]){
      throw 'LIVE_CONFIG_CHANGED_DURING_PREFLIGHT'
    }
  }
  try{
    Copy-Item -LiteralPath $download -Destination $module -Force
    [System.IO.File]::WriteAllText($server,$text,$utf8)
    [System.IO.File]::WriteAllText($projects,$newProjects+$lf,$utf8)
    [System.IO.File]::WriteAllText($config,$newConfig+$lf,$utf8)
    & $node --check $server
    if($LASTEXITCODE -ne 0){throw 'INSTALLED_SERVER_SYNTAX_INVALID'}
    $env:RESEARCH_INBOX_PROBE_SERVER=$server
    $env:RESEARCH_INBOX_PROBE_CONFIG=$projects
    $probe=@'
import fs from "node:fs";
import {pathToFileURL} from "node:url";
const {makeHandler}=await import(pathToFileURL(process.env.RESEARCH_INBOX_PROBE_SERVER).href);
const c=JSON.parse(fs.readFileSync(process.env.RESEARCH_INBOX_PROBE_CONFIG,"utf8"));
const result=await makeHandler(c)({jsonrpc:"2.0",id:1,method:"tools/list"});
const names=new Set(result?.result?.tools?.map(t=>t.name)??[]);
for(const name of ["read_research_tasks","propose_research_task","inspect_project_writer","read_project_policy"]){
  if(!names.has(name))throw new Error("MISSING_TOOL_"+name);
}
console.log("NATIVE_RESEARCH_TOOLS_VERIFIED");
'@
    $probeFile=Join-Path $stage 'native-tools-probe.mjs'
    [System.IO.File]::WriteAllText($probeFile,$probe,$utf8)
    & $node $probeFile
    if($LASTEXITCODE -ne 0){throw 'NATIVE_TOOL_PROBE_FAILED'}
    Write-Output 'RESEARCH_INBOX_V3_INSTALLED_AND_VERIFIED'
    Write-Output ('BACKUP='+$backup)
    Write-Output 'NEXT: codexify service restart'
    Write-Output 'Then refresh God v5 and start a new ChatGPT conversation.'
  }catch{
    Copy-Item -LiteralPath (Join-Path $backup 'server.mjs') -Destination $server -Force
    Copy-Item -LiteralPath (Join-Path $backup 'projects.json') -Destination $projects -Force
    Copy-Item -LiteralPath (Join-Path $backup 'codexify.config.json') -Destination $config -Force
    if($moduleExisted){Copy-Item -LiteralPath (Join-Path $backup 'fleet-research-inbox.mjs') -Destination $module -Force}
    elseif(Test-Path -LiteralPath $module){Remove-Item -LiteralPath $module -Force}
    Write-Error ('INSTALL_ROLLED_BACK: '+$_.Exception.Message)
    throw
  }
}finally{
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
