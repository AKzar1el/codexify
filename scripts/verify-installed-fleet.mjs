// Read-only verification of the live fleet MCP actions and host-facing annotations.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const home=process.env.USERPROFILE;
const dir=path.join(home,'.codexify','revenue-shot-direct-v041');
const cfg=JSON.parse(await fs.readFile(path.join(dir,'projects.json'),'utf8'));
const module=await import(pathToFileURL(path.join(dir,'server.mjs')).href);
const result=await module.makeHandler(cfg)({jsonrpc:'2.0',id:1,method:'tools/list'});
if(result.error)throw Error('MCP_TOOL_LIST_ERROR');
const tools=result?.result?.tools||[];
const expected=['plan_scoped_worktree','create_scoped_worktree',
 'preflight_worktree_action','apply_scoped_worktree_edit',
 'run_scoped_worktree_check'];
if(tools.length!==13)throw Error('EXPECTED_13_TOOLS_GOT_'+tools.length);
for(const name of expected){
 const tool=tools.find(v=>v.name===name);
 if(!tool)throw Error('MISSING_TOOL_'+name);
 const shouldRead=name==='plan_scoped_worktree'||name==='preflight_worktree_action';
 if(tool.annotations?.readOnlyHint!==shouldRead)
  throw Error('MISMATCHED_HOST_ANNOTATION_'+name);
}
const projects=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
if(JSON.stringify(Object.keys(cfg.scopedWorktreePolicies).sort())!==
 JSON.stringify(projects))throw Error('NOT_ALL_SIX_PROJECTS_ENABLED');
if(cfg.enableWrites!==false||cfg.enableCodingWrites!==false||
 cfg.enableProjectChecks!==false)throw Error('GLOBAL_WRITE_GATE_CHANGED');
console.log(JSON.stringify({status:'FLEET_CATALOG_VERIFIED',
 tools:tools.length,newActions:expected,projects,
 globalJournalWrites:cfg.enableWrites,globalCodingWrites:cfg.enableCodingWrites,
 generalProjectChecks:cfg.enableProjectChecks,remoteEffectsAuthorized:false}));
