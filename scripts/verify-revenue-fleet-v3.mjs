// Pure read-only verification for the installed Fleet v3 server sidecar.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const exec=promisify(execFile);
const home=process.env.USERPROFILE;
const side=path.join(home,'.codexify','revenue-shot-direct-v041');
const cfg=JSON.parse(await fs.readFile(path.join(side,'projects.json'),'utf8'));
const {makeHandler}=await import(pathToFileURL(path.join(side,'server.mjs')).href);
const h=makeHandler(cfg);
const res=await h({jsonrpc:'2.0',id:1,method:'tools/list'});
if(res?.error)throw Error('MCP_TOOLS_LIST_FAILED');
const tools=res?.result?.tools||[];
if(tools.length!==13)throw Error('EXPECTED_13_TOOLS_GOT_'+tools.length);
const plan=tools.find(t=>t.name==='plan_scoped_worktree');
const make=tools.find(t=>t.name==='create_scoped_worktree');
for(const tool of [plan,make]){
  const props=tool?.inputSchema?.properties??{};
  if(JSON.stringify(props.baseline_mode?.enum)!==
     JSON.stringify(['local-main','remote-main'])||
     props.expected_local_main_sha?.pattern!=='^[a-f0-9]{40}$')
    throw Error('FRESH_BASELINE_NATIVE_SCHEMA_MISSING');
}
if(plan.annotations.readOnlyHint!==true||
   make.annotations.readOnlyHint!==false)
  throw Error('ACTION_ANNOTATION_CHANGED');
if(cfg.enableWrites!==false||cfg.enableCodingWrites!==false||
   cfg.enableProjectChecks!==false||cfg.enableScopedWorktreeActions!==true)
  throw Error('CANONICAL_PERMISSION_GATE_CHANGED');
const registered=await h({jsonrpc:'2.0',id:2,method:'tools/call',
  params:{name:'read_project_worktree_file',arguments:{
    project:'nofax',repository:'root',
    worktree_id:'f5d6dfa0b545a76e80df',
    path:'test/mcp-tools.test.mjs',offset:0,limit:6}}});
if(registered.result?.isError||
   registered.result?.structuredContent?.worktree_id!=='f5d6dfa0b545a76e80df')
  throw Error('LEGACY_V1_READER_REGRESSION');
let baselineCount=0;
for(const project of ['geo','godprompt','gsc','nofax','trendpulse','webvalidator']){
  const names=Object.keys(cfg.coding[project].gitRoots);
  for(const alias of names){
    const repo=path.resolve(cfg.projects[project],cfg.coding[project].gitRoots[alias]);
    const opts={cwd:repo,timeout:10000,windowsHide:true,maxBuffer:2048,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}};
    const local=(await exec('git',['rev-parse','refs/heads/main'],opts)).stdout.trim();
    const remote=(await exec('git',['rev-parse','refs/remotes/origin/main'],opts)).stdout.trim();
    if(!/^[0-9a-f]{40}$/.test(local)||!/^[0-9a-f]{40}$/.test(remote))
      throw Error('GIT_BASELINE_SHA_INVALID_'+project+'/'+alias);
    await exec('git',['merge-base','--is-ancestor',local,remote],opts);
    baselineCount++;
  }
}
console.log(JSON.stringify({status:'FLEET_V3_FRESH_BASELINE_TOOL_CATALOG_VERIFIED',
  tools:tools.length,baselineCount,v1Readback:true,canonicalWriteGatesDisabled:true}));
