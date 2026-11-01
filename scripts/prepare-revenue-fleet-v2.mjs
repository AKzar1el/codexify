// Exactly scoped, owner-activated Revenue Shot v2 sidecar upgrade.
// Pure planning and tests do not modify the running sidecar.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';

const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const OLD=Object.freeze({
  server:'8E2FF4F7880B2107488A1CCC45CD31A06AAFC9756B64F18DCCEF40B38FE9E8C7',
  config:'7DEB19859D8A0A1B1048983D13318F8B16BB45EFBE96A692BE3926CFD04C5903',
  coding:'DAA61919C805C3299B3E2605C5861EF4469DB4AAF3E820E573061676418897E8',
  helper:'095A30433320A38C59981F4BC9CEA73BD54F8D63990D6C65C12DDCD9EBF7B36A'
});
const PROJECTS=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
const PREFIXES=Object.freeze({
  geo:['src/','tests/'],
  godprompt:['src/','bench/','tests/'],
  gsc:['src/','tests/'],
  nofax:['src/','test/'],
  trendpulse:['src/','tests/'],
  webvalidator:['src/','test/']
});
function single(source,needle,replacement){
  const at=source.indexOf(needle);
  if(at<0||source.indexOf(needle,at+needle.length)!==-1)
    throw Error('SERVER_ANCHOR_MISSING_OR_AMBIGUOUS');
  return source.slice(0,at)+replacement+source.slice(at+needle.length);
}
function equalJSON(a,b){return JSON.stringify(a)===JSON.stringify(b);}
export function prepare(input) {
  for(const key of Object.keys(OLD)){
    if(sha(input[key])!==OLD[key])throw Error('BASELINE_CHANGED_'+key.toUpperCase());
  }
  const cfg=JSON.parse(input.config.toString('utf8'));
  if(!cfg.enableScopedWorktreeActions||cfg.enableWrites!==false
    ||cfg.enableCodingWrites!==false||cfg.enableProjectChecks!==false
    ||cfg.enableCodingRead!==true
    ||!equalJSON(Object.keys(cfg.scopedWorktreePolicies).sort(),PROJECTS))
    throw Error('UNEXPECTED_BASELINE_POLICY');
  const previous=structuredClone(cfg);
  const patchNotes=[];
  for(const project of PROJECTS){
    const policy=cfg.scopedWorktreePolicies[project];
    if(policy.enabled!==true||!policy.checks.includes('source-diff')
      ||policy.checks.includes('project-unit')||!policy.writePrefixes.includes('src/'))
      throw Error('UNEXPECTED_PROJECT_SCOPE_'+project);
    const newPrefixes=PREFIXES[project];
    policy.writePrefixes=[...new Set([...policy.writePrefixes,...newPrefixes])];
    policy.checks=[...policy.checks,'project-unit'];
    patchNotes.push({project,checks:policy.checks,writePrefixes:policy.writePrefixes});
  }
  const priorServer=input.server.toString('utf8');
  let newServer=single(priorServer,
    'check_id:{type:"string",enum:["source-diff","launcher"]}',
    'check_id:{type:"string",enum:["source-diff","launcher","project-unit"]}');
  newServer=single(newServer,
    'Run only project-approved bounded source-diff or GSC launcher check after a verified isolated source edit.',
    'Run only project-approved bounded source-diff, GSC launcher, or fixed per-repository unit test after a verified isolated edit.');
  const expectedServer=Buffer.from(newServer,'utf8');
  const expectedConfig=Buffer.from(JSON.stringify(cfg,null,2)+'\n','utf8');
  // Ensure no changes other than the intended check and allowlisted test path scope.
  for(const project of PROJECTS) {
    previous.scopedWorktreePolicies[project].checks=cfg.scopedWorktreePolicies[project].checks;
    previous.scopedWorktreePolicies[project].writePrefixes=cfg.scopedWorktreePolicies[project].writePrefixes;
  }
  if(!equalJSON(previous,cfg))throw Error('CONFIG_UNRELATED_CHANGE');
  const newCoding=input.sourceCoding;
  const newHelper=input.sourceHelper;
  if(!Buffer.isBuffer(newCoding)||!Buffer.isBuffer(newHelper))
    throw Error('STAGED_MODULES_REQUIRED');
  if(!newCoding.toString('utf8').includes('approvedWorktreeLocation(')
     ||!newHelper.toString('utf8').includes('async function projectUnitCheck(')
     ||!newHelper.toString('utf8').includes('read_scoped_worktree_source(args)'))
    throw Error('STAGED_IMPLEMENTATION_NOT_FOUND');
  return {server:expectedServer,config:expectedConfig,
    coding:newCoding,helper:newHelper,
    details:{projects:patchNotes,canonicalWrites:false,
      remoteGit:false,originalRunLedgerWrites:false,
      nativeToolCount:13,unitChecks:'fixed seven-repository commands',
      reader:'registered exact external fleet worktree only'}};
}
export function pathsFor(home,checkout){
  const side=path.join(home,'.codexify','revenue-shot-direct-v041');
  return {
    side,
    backupRoot:path.join(home,'.codexify','maintenance'),
    server:path.join(side,'server.mjs'),
    config:path.join(side,'projects.json'),
    coding:path.join(side,'coding.mjs'),
    helper:path.join(side,'fleet-scoped-worktree-actions.mjs'),
    sourceCoding:path.join(checkout,'scripts','fleet-coding-reader-v2.mjs'),
    sourceHelper:path.join(checkout,'scripts','fleet-scoped-worktree-actions.mjs')
  };
}
async function create(file,buffer){
  const bytes=Buffer.from(buffer);
  let handle;
  try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(bytes);await handle.sync();}
  finally{if(handle)await handle.close();}
  if(!(await fs.readFile(file)).equals(bytes))throw Error('DURABLE_READBACK_FAILED');
}
async function replace(file,bytes){
  const temp=path.join(path.dirname(file),'.revenue-v2-'+randomUUID()+'.tmp');
  try{await create(temp,bytes);await fs.rename(temp,file);}
  finally{await fs.unlink(temp).catch(()=>{});}
  if(!(await fs.readFile(file)).equals(bytes))throw Error('REPLACEMENT_READBACK_FAILED');
}
export async function inspect(paths){
  const [server,config,coding,helper,sourceCoding,sourceHelper]=await Promise.all([
    fs.readFile(paths.server),fs.readFile(paths.config),
    fs.readFile(paths.coding),fs.readFile(paths.helper),
    fs.readFile(paths.sourceCoding),fs.readFile(paths.sourceHelper)
  ]);
  const current={server,config,coding,helper};
  const planned=prepare({...current,sourceCoding,sourceHelper});
  return {current,planned,after:Object.fromEntries(
    Object.keys(OLD).map(key=>[key,sha(planned[key])]))};
}
export async function install(paths,{apply=false}={}){
  const snapshot=await inspect(paths);
  if(!apply)return {status:'DRY_RUN_OK',oldHashes:OLD,
    newHashes:snapshot.after,details:snapshot.planned.details};
  if(!process.stdin.isTTY||process.env.REVENUE_ACTION_OWNER_APPROVAL!=='REVENUE_FLEET_V2')
    throw Error('INTERACTIVE_HOST_APPROVAL_REQUIRED');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  let approval;
  try{approval=await rl.question('Type APPROVE REVENUE FLEET V2 to continue: ');}
  finally{rl.close();}
  if(approval!=='APPROVE REVENUE FLEET V2')throw Error('OWNER_DID_NOT_APPROVE');
  for(const key of Object.keys(OLD)){
    if(sha(await fs.readFile(paths[key]))!==OLD[key])
      throw Error('BASELINE_CHANGED_DURING_APPROVAL');
  }
  const backup=path.join(paths.backupRoot,'fleet-v2-backup-'+Date.now());
  await fs.mkdir(backup,{recursive:false});
  for(const key of Object.keys(OLD)){
    await create(path.join(backup,key+'.before'),snapshot.current[key]);
  }
  const changed=[];
  try{
    for(const key of Object.keys(OLD)){
      changed.push(key);
      await replace(paths[key],snapshot.planned[key]);
    }
    for(const key of Object.keys(OLD)){
      if(sha(await fs.readFile(paths[key]))!==snapshot.after[key])
        throw Error('POSTWRITE_HASH_MISMATCH_'+key);
    }
    const receipt={status:'INSTALLED_NOT_RELOADED',
      backup,oldHashes:OLD,newHashes:snapshot.after,
      details:snapshot.planned.details,utc:new Date().toISOString()};
    await create(path.join(backup,'installation-receipt.json'),
      Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
    return receipt;
  }catch(e){
    // Retain backup for audit. Restore only files this exact installer replaced.
    for(const key of changed.reverse()){
      await replace(paths[key],snapshot.current[key]);
    }
    throw e;
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const option=process.argv[2];
  if(option!=='--check'&&option!=='--apply'){
    console.error('Usage: node prepare-revenue-fleet-v2.mjs --check|--apply');
    process.exitCode=2;
  }else{
    const home=process.env.USERPROFILE;
    const checkout=path.resolve(path.dirname(process.argv[1]),'..');
    install(pathsFor(home,checkout),{apply:option==='--apply'})
      .then(x=>console.log(JSON.stringify(x,null,2)))
      .catch(e=>{console.error(e.message||'INSTALL_FAILURE');process.exitCode=1;});
  }
}
