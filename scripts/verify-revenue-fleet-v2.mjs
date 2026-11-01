// Read-only health/registration verification after the approved v2 service swap.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const home=process.env.USERPROFILE;
const base=path.join(home,'.codexify','revenue-shot-direct-v041');
const cfg=JSON.parse(await fs.readFile(path.join(base,'projects.json'),'utf8'));
const {makeHandler}=await import(pathToFileURL(path.join(base,'server.mjs')).href);
const handler=makeHandler(cfg);
const listing=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
if(listing.error)throw Error('MCP_LIST_FAILED');
const tools=listing?.result?.tools||[];
if(tools.length!==13)throw Error('EXPECTED_13_ACTIONS_GOT_'+tools.length);
const check=tools.find(x=>x.name==='run_scoped_worktree_check');
if(JSON.stringify(check?.inputSchema?.properties?.check_id?.enum)!==
  JSON.stringify(['source-diff','launcher','project-unit']))
  throw Error('PROJECT_UNIT_ENUM_NOT_REGISTERED');
if(cfg.enableWrites!==false||cfg.enableCodingWrites!==false
  ||cfg.enableProjectChecks!==false||cfg.enableCodingRead!==true)
  throw Error('GLOBAL_GATES_CHANGED');
const projects=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
if(projects.some(x=>!cfg.scopedWorktreePolicies[x]?.checks?.includes('project-unit')))
  throw Error('UNIT_CHECK_POLICY_MISSING');
const res=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{
  name:'read_project_worktree_file',
  arguments:{project:'nofax',repository:'root',
    worktree_id:'f5d6dfa0b545a76e80df',
    path:'src/mcp-tools.mjs',offset:280,limit:70}
}});
if(res.result?.isError||!res.result?.structuredContent?.content?.includes('confirmationStatus'))
  throw Error('LIVE_EXTERNAL_READER_NOT_WORKING');
console.log(JSON.stringify({status:'FLEET_V2_READER_AND_TEST_CATALOG_VERIFIED',
  toolCount:tools.length,projects,unitTestId:'project-unit',
  liveNoFaxExternalRead:true,globalWrites:false}));
