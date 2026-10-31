// Owner-reviewed, one-project install plan for the Revenue Shot GSC worktree canary.
// --check: read-only; --apply: explicit interactive owner action only.
// Existing canonical journal writes, canonical code writes and general checks remain disabled.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';

const digest=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
const BASELINES={
  server:'50A00D8F75C989B8F570176832FF6E3425C517D7F3FA8D06F7082EC8D4DFE5CB',
  config:'2DE7DA8D5F9B12D16B2C6932DC416A2D25B35E380273D790ECCFE271A1912EAF',
  helper:'C38F5733686F527C021256D1FFF9A8F22D618B75376E02FCB26D664D692B0261'
};
function one(text,needle,replacement){
  const pos=text.indexOf(needle);
  if(pos<0||text.indexOf(needle,pos+needle.length)>=0)throw Error('SERVER_ANCHOR_NOT_UNIQUE');
  return text.slice(0,pos)+replacement+text.slice(pos+needle.length);
}
export function prepare(server,config,helper,fragment,home){
  const existingConfig=Buffer.from(config,'utf8');
  if(digest(Buffer.from(server,'utf8'))!==BASELINES.server ||
     digest(existingConfig)!==BASELINES.config ||
     digest(helper)!==BASELINES.helper)throw Error('UNRECOGNIZED_PRODUCTION_BASELINE');
  const parsed=JSON.parse(config);
  if(parsed.enableWrites!==false||parsed.enableCodingWrites!==false||
     parsed.enableProjectChecks!==false||parsed.enableCodingRead!==true||
     Object.hasOwn(parsed,'enableScopedWorktreeActions'))
     throw Error('PRODUCTION_PERMISSION_BASELINE_CHANGED');
  const required=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
  if(JSON.stringify(Object.keys(parsed.projects).sort())!==JSON.stringify(required))
    throw Error('UNEXPECTED_PROJECT_SET');
  if(Object.values(parsed.coding).some(p=>
    (p.writePrefixes?.length??0)>0||Object.keys(p.checks??{}).length>0))
    throw Error('EXISTING_WRITER_POLICY_CHANGED');
  const prefix='import { createCodingService } from "./coding.mjs";';
  let updated=one(server,prefix,prefix+'\n'+
    'import { createScopedWorktreeActions } from "./scoped-worktree-actions.mjs";');
  updated=one(updated,'  return list;\n}\nexport function makeHandler(config)',
    fragment.trimEnd()+'\n  return list;\n}\nexport function makeHandler(config)');
  const originalService='const service = { ...createRevenueService(config), ...createCodingService(config) };';
  updated=one(updated,originalService,
    'const service = { ...createRevenueService(config), ...createCodingService(config),\n'+
    '    ...createScopedWorktreeActions(config) };');
  parsed.enableScopedWorktreeActions=true;
  parsed.scopedWorktreePolicies={
    gsc:{enabled:true,branchPrefix:'revenue-shot/',
      writeFiles:['scripts/glama-start.mjs'],checks:['launcher'],
      checkCommand:'node-test-launcher'}
  };
  parsed.worktreeActionRecordsRoot=path.join(home,'.codexify','maintenance','scoped-worktree-actions');
  return {server:Buffer.from(updated,'utf8'),
    config:Buffer.from(JSON.stringify(parsed,null,2)+'\n','utf8'),helper,
    details:{pilot:'gsc',sourceFiles:['scripts/glama-start.mjs'],
      approvedChecks:['launcher'],canonicalJournalWrites:false,
      canonicalCodingWrites:false,generalChecks:false,
      scope:'dedicated GSC worktrees; no push/merge/release/external effects'}};
}
async function createVerified(file,bytes){
  let handle=null;
  try{
    handle=await fs.open(file,'wx',0o600);
    await handle.writeFile(bytes);await handle.sync();
  }finally{if(handle)await handle.close();}
  if(!(await fs.readFile(file)).equals(bytes))throw Error('DURABLE_READBACK_MISMATCH');
}
async function replaceVerified(file,bytes){
  const temp=path.join(path.dirname(file),'.revenue-scoped-'+randomUUID()+'.tmp');
  try{await createVerified(temp,bytes);await fs.rename(temp,file);}
  finally{await fs.unlink(temp).catch(()=>{});}
  if(!(await fs.readFile(file)).equals(bytes))throw Error('ATOMIC_REPLACEMENT_FAILED');
}
export function pathsFor(home,checkout){
  const sidecar=path.join(home,'.codexify','revenue-shot-direct-v041');
  const maintenance=path.join(home,'.codexify','maintenance');
  return {server:path.join(sidecar,'server.mjs'),
    config:path.join(sidecar,'projects.json'),
    targetHelper:path.join(sidecar,'scoped-worktree-actions.mjs'),
    helper:path.join(home,'Desktop','lol','revenue-shot-supervisor','scoped-worktree-actions.mjs'),
    fragment:path.join(checkout,'scripts','revenue-scoped-tools.fragment'),
    maintenance};
}
export async function inspect(paths,home){
  const [server,config,helper,fragment]=await Promise.all([
    fs.readFile(paths.server,'utf8'),fs.readFile(paths.config,'utf8'),
    fs.readFile(paths.helper),fs.readFile(paths.fragment,'utf8')]);
  const value=prepare(server,config,helper,fragment,home);
  return {value,before:{server:Buffer.from(server),config:Buffer.from(config)},
    sha:{server:digest(value.server),config:digest(value.config),helper:digest(value.helper)}};
}
export async function run(paths,home,apply=false){
  const snapshot=await inspect(paths,home);
  if(!apply)return {status:'DRY_RUN_OK',sha:snapshot.sha,details:snapshot.value.details};
  if(!process.stdin.isTTY||process.env.REVENUE_ACTION_OWNER_APPROVAL!=='SCOPED_GSC_ONLY')
    throw Error('OWNER_INTERACTIVE_APPROVAL_REQUIRED');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  let answer;
  try{answer=await rl.question('Type APPROVE GSC SCOPED ACTIONS to continue: ');}
  finally{rl.close();}
  if(answer!=='APPROVE GSC SCOPED ACTIONS')throw Error('APPROVAL_NOT_GIVEN');
  if(await fs.stat(paths.targetHelper).then(()=>true).catch(()=>false))
    throw Error('SCOPED_HELPER_ALREADY_PRESENT');
  const backup=path.join(paths.maintenance,'scoped-gsc-backup-'+Date.now());
  await fs.mkdir(backup,{recursive:false});
  await createVerified(path.join(backup,'server.before.mjs'),snapshot.before.server);
  await createVerified(path.join(backup,'projects.before.json'),snapshot.before.config);
  const touched=[];
  try{
    await fs.mkdir(path.join(paths.maintenance,'scoped-worktree-actions'),{recursive:true});
    touched.push('helper');await createVerified(paths.targetHelper,snapshot.value.helper);
    touched.push('server');await replaceVerified(paths.server,snapshot.value.server);
    touched.push('config');await replaceVerified(paths.config,snapshot.value.config);
    for(const [key,file] of [['server',paths.server],['config',paths.config],['helper',paths.targetHelper]]){
      if(digest(await fs.readFile(file))!==snapshot.sha[key])throw Error('INSTALLED_HASH_MISMATCH');
    }
    const receipt={status:'INSTALLED_NOT_RELOADED',backup,
      before:{server:BASELINES.server,config:BASELINES.config},
      installed:snapshot.sha,details:snapshot.value.details,utc:new Date().toISOString()};
    await createVerified(path.join(backup,'installation-receipt.json'),
      Buffer.from(JSON.stringify(receipt,null,2)+'\n','utf8'));
    return receipt;
  }catch(e){
    // Roll back only our own modifications; preserve originals and backup.
    if(touched.includes('config'))await replaceVerified(paths.config,snapshot.before.config);
    if(touched.includes('server'))await replaceVerified(paths.server,snapshot.before.server);
    if(touched.includes('helper'))await fs.unlink(paths.targetHelper).catch(()=>{});
    throw e;
  }
}
const mainPath=process.argv[1];
if(mainPath&&fileURLToPath(import.meta.url)===path.resolve(mainPath)){
  const arg=process.argv[2];
  if(arg!=='--check'&&arg!=='--apply'){
    console.error('Usage: node prepare-revenue-scoped-gsc.mjs --check|--apply');
    process.exitCode=2;
  }else{
    const home=process.env.USERPROFILE;
    if(!home){console.error('USERPROFILE_REQUIRED');process.exitCode=2;}
    else run(pathsFor(home,path.resolve(path.dirname(mainPath),'..')),home,arg==='--apply')
      .then(value=>console.log(JSON.stringify(value,null,2)))
      .catch(error=>{console.error(error?.message||'INSTALL_FAILED');process.exitCode=1;});
  }
}
