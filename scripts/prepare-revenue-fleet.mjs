// Upgrade the approved GSC canary to fixed-project fleet worktree tools.
// --check has no side effects. --apply is interactive, requires explicit owner
// approval and preserves the original files for a separately verified restart.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';

const sha=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
const expected={
  server:'0B88C17B120EE1729BC14CC80352D39DA416E30C9D3D378D7DA8639B8764FCEB',
  config:'88054B42440AC01FF05116BE667D89C64172F703FC9F3EFD2AE28836A095E744',
  currentHelper:'C38F5733686F527C021256D1FFF9A8F22D618B75376E02FCB26D664D692B0261'
};
function one(text,needle,replacement){
 const i=text.indexOf(needle);
 if(i<0||text.indexOf(needle,i+needle.length)>=0)throw Error('ANCHOR_NOT_UNIQUE');
 return text.slice(0,i)+replacement+text.slice(i+needle.length);
}
export function prepare(server,config,currentHelper,fleetHelper,initHelper,fragment,home){
 if(sha(Buffer.from(server))!==expected.server||
    sha(Buffer.from(config))!==expected.config||
    sha(currentHelper)!==expected.currentHelper)
   throw Error('CURRENT_GSC_CANARY_BASELINE_CHANGED');
 const c=JSON.parse(config);
 if(!c.enableScopedWorktreeActions||c.enableWrites!==false||
    c.enableCodingWrites!==false||c.enableProjectChecks!==false||
    c.enableCodingRead!==true)throw Error('UNEXPECTED_WRITE_POLICY');
 const expectedProjects=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
 if(JSON.stringify(Object.keys(c.projects).sort())!==JSON.stringify(expectedProjects))
   throw Error('FLEET_SCOPE_CHANGED');
 if(JSON.stringify(Object.keys(c.scopedWorktreePolicies))!=='["gsc"]')
   throw Error('GSC_PILOT_POLICY_CHANGED');
 if(c.scopedWorktreePolicies.gsc?.writeFiles?.join(',')!=='scripts/glama-start.mjs')
   throw Error('GSC_SOURCE_SCOPE_CHANGED');
 const policies={};
 for(const project of expectedProjects){
   policies[project]={
     enabled:true,branchPrefix:'revenue-shot/',
     allowedRepositories:project==='godprompt'?['primary','companion']:['root'],
     writeFiles:project==='gsc'?['scripts/glama-start.mjs']:
       project==='godprompt'?['build.py']:[],
     writePrefixes:project==='godprompt'?['src/','bench/']:['src/'],
     checks:project==='gsc'?['launcher','source-diff']:['source-diff'],
     checkCommand:project==='gsc'?'node-test-launcher':'git-diff-check'
   };
 }
 policies.gsc.checkCommands={'source-diff':'git-diff-check'};
 c.scopedWorktreePolicies=policies;
 let updated=one(server,
  'import { createScopedWorktreeActions } from "./scoped-worktree-actions.mjs";',
  'import { createScopedWorktreeActions } from "./fleet-scoped-worktree-actions.mjs";\n'+
  'import { createFleetWorktreeInitializer } from "./fleet-worktree-init.mjs";');
 const start='  // GSC-only native worktree actions. Host approval must apply to write tools.';
 const end='  return list;\n}\nexport function makeHandler(config)';
 const begin=updated.indexOf(start),stop=updated.indexOf(end,begin);
 if(begin<0||stop<0||updated.indexOf(start,begin+start.length)>=0)
   throw Error('GSC_FRAGMENT_BOUNDARY_CHANGED');
 updated=updated.slice(0,begin)+fragment.trimEnd()+'\n'+updated.slice(stop);
 updated=one(updated,
  '    ...createScopedWorktreeActions(config) };',
  '    ...createScopedWorktreeActions(config), ...createFleetWorktreeInitializer(config) };');
 return {server:Buffer.from(updated,'utf8'),
  config:Buffer.from(JSON.stringify(c,null,2)+'\n','utf8'),
  fleetHelper,initHelper,
  details:{enabledProjects:expectedProjects,noncanonicalWorktreesOnly:true,
    sourcePrefixes:['src/','bench/ (GodPrompt primary only)'],sourceDiffCheckAll:true,
    gscLauncherRetained:true,globalJournalWrites:c.enableWrites,
    globalCodingWrites:c.enableCodingWrites,
    globalProjectChecks:c.enableProjectChecks,
    localBranchBase:'refs/heads/main',remoteActions:false}};
}
async function create(file,bytes){
 let handle;try{handle=await fs.open(file,'wx',0o600);
   await handle.writeFile(bytes);await handle.sync();}
 finally{if(handle)await handle.close();}
 if(!(await fs.readFile(file)).equals(bytes))throw Error('RECEIPT_WRITE_NOT_DURABLE');
}
async function swap(file,bytes){
 const temp=path.join(path.dirname(file),'.fleet-prep-'+randomUUID()+'.tmp');
 try{await create(temp,bytes);await fs.rename(temp,file);}
 finally{await fs.unlink(temp).catch(()=>{});}
 if(!(await fs.readFile(file)).equals(bytes))throw Error('SWAP_READBACK_FAILED');
}
export function pathsFor(home,checkout){
 const side=path.join(home,'.codexify','revenue-shot-direct-v041');
 const base=path.join(checkout,'scripts');
 return {
  side,maintenance:path.join(home,'.codexify','maintenance'),
  server:path.join(side,'server.mjs'),config:path.join(side,'projects.json'),
  currentHelper:path.join(side,'scoped-worktree-actions.mjs'),
  targetFleet:path.join(side,'fleet-scoped-worktree-actions.mjs'),
  targetInit:path.join(side,'fleet-worktree-init.mjs'),
  sourceFleet:path.join(base,'fleet-scoped-worktree-actions.mjs'),
  sourceInit:path.join(base,'fleet-worktree-init.mjs'),
  fragment:path.join(base,'revenue-fleet-tools.fragment')
 };
}
export async function inspect(paths,home){
 const [server,config,currentHelper,fleetHelper,initHelper,fragment]=await Promise.all([
  fs.readFile(paths.server),fs.readFile(paths.config),
  fs.readFile(paths.currentHelper),fs.readFile(paths.sourceFleet),
  fs.readFile(paths.sourceInit),fs.readFile(paths.fragment,'utf8')
 ]);
 const planned=prepare(server.toString('utf8'),config.toString('utf8'),
  currentHelper,fleetHelper,initHelper,fragment,home);
 return {planned,previous:{server,config},
   sha:{server:sha(planned.server),config:sha(planned.config),
     fleetHelper:sha(planned.fleetHelper),initHelper:sha(planned.initHelper)}};
}
export async function install(paths,home,{apply=false}={}){
 const pre=await inspect(paths,home);
 if(!apply)return {status:'DRY_RUN_OK',sha:pre.sha,details:pre.planned.details};
 if(!process.stdin.isTTY||process.env.REVENUE_ACTION_OWNER_APPROVAL!=='SCOPED_FLEET_V1')
   throw Error('INTERACTIVE_OWNER_APPROVAL_REQUIRED');
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});
 let answer;try{answer=await rl.question('Type APPROVE FLEET SCOPED ACTIONS to continue: ');}
 finally{rl.close();}
 if(answer!=='APPROVE FLEET SCOPED ACTIONS')throw Error('OWNER_APPROVAL_REJECTED');
 for(const p of [paths.targetFleet,paths.targetInit]){
  if(await fs.stat(p).then(()=>true).catch(()=>false))
   throw Error('FLEET_HELPER_ALREADY_PRESENT');
 }
 const backup=path.join(paths.maintenance,'fleet-scoped-backup-'+Date.now());
 await fs.mkdir(backup,{recursive:false});
 await create(path.join(backup,'server.before.mjs'),pre.previous.server);
 await create(path.join(backup,'projects.before.json'),pre.previous.config);
 const touched=[];
 try{
  touched.push('fleet');await create(paths.targetFleet,pre.planned.fleetHelper);
  touched.push('init');await create(paths.targetInit,pre.planned.initHelper);
  touched.push('server');await swap(paths.server,pre.planned.server);
  touched.push('config');await swap(paths.config,pre.planned.config);
  const list=[['server',paths.server],['config',paths.config],
    ['fleetHelper',paths.targetFleet],['initHelper',paths.targetInit]];
  for(const [key,file] of list){
    if(sha(await fs.readFile(file))!==pre.sha[key])throw Error('INSTALLED_HASH_MISMATCH');
  }
  const receipt={status:'INSTALLED_NOT_RELOADED',backup,sha:pre.sha,
    details:pre.planned.details,utc:new Date().toISOString()};
  await create(path.join(backup,'installation-receipt.json'),
    Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
  return receipt;
 }catch(e){
  if(touched.includes('config'))await swap(paths.config,pre.previous.config);
  if(touched.includes('server'))await swap(paths.server,pre.previous.server);
  // Keep newly installed helper artifacts as forensic files. Restored server
  // imports the old helper and does not expose their actions.
  throw e;
 }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const option=process.argv[2];
 if(!['--check','--apply'].includes(option)){
  console.error('Usage: node prepare-revenue-fleet.mjs --check|--apply');
  process.exitCode=2;
 }else{
  const home=process.env.USERPROFILE;
  install(pathsFor(home,path.resolve(path.dirname(process.argv[1]),'..')),home,
    {apply:option==='--apply'})
   .then(v=>console.log(JSON.stringify(v,null,2)))
   .catch(e=>{console.error(e?.message||'INSTALL_FAILURE');process.exitCode=1;});
 }
}
