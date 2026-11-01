// Fleet v3: guarded four-file upgrade for fresh remote-main worktree lanes.
// Never changes the canonical repositories, journal, scheduler, or global write gates.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import readline from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
export const BASELINE=Object.freeze({
  server:'D22F0F2DB2E8062EA0ADBAD9D3A3377848BFE91FA5FF53F20D85D7242EC80D8F',
  coding:'E7CDC97F2640D31C82715DA7EDC93AF23666B1E9A6E6E916E319DB24318C7E0A',
  helper:'0FC1A6DCE04EF0CD6B63E3DBE636A52FBE0C56AB567E5B5076012FFD97BDC413',
  initializer:'FE840A7ECA8A5F7FD818CA25C3380B1FAD9B1C8F79971FB4D76B396338E78E0F',
  config:'97B94C302C8D1E1D6AFC0809D76FF14DFF42C682B285C68627CBED53BE561AA3'
});
const FILES={server:'server.mjs',coding:'coding.mjs',
  helper:'fleet-scoped-worktree-actions.mjs',initializer:'fleet-worktree-init.mjs'};
const PROJECTS=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
function assure(v,message){if(!v)throw Error(message);}
export function pathsFor(home,checkout){
  const side=path.join(home,'.codexify','revenue-shot-direct-v041');
  return {side,backup:path.join(home,'.codexify','maintenance'),
    live:Object.fromEntries(Object.entries(FILES).map(([k,v])=>[k,path.join(side,v)])),
    config:path.join(side,'projects.json'),
    staged:{server:path.join(checkout,'scripts','fleet-server-v3.mjs'),
      coding:path.join(checkout,'scripts','fleet-coding-reader-v2.mjs'),
      helper:path.join(checkout,'scripts','fleet-scoped-worktree-actions.mjs'),
      initializer:path.join(checkout,'scripts','fleet-worktree-init.mjs')}};
}
export async function inspect(paths){
  const names=Object.keys(FILES);
  const [configBytes,...current]=await Promise.all([
    fs.readFile(paths.config),...names.map(k=>fs.readFile(paths.live[k]))
  ]);
  assure(sha(configBytes)===BASELINE.config,'LIVE_CONFIG_HASH_CHANGED');
  const config=JSON.parse(configBytes.toString('utf8'));
  assure(config.enableWrites===false&&config.enableCodingWrites===false
    &&config.enableProjectChecks===false&&config.enableScopedWorktreeActions===true
    &&config.enableCodingRead===true,'DANGEROUS_OR_INCOMPATIBLE_SCOPE_CONFIG');
  assure(JSON.stringify(Object.keys(config.scopedWorktreePolicies).sort())===
    JSON.stringify(PROJECTS),'SCOPE_FLEET_CHANGED');
  for(const p of PROJECTS) {
    const scope=config.scopedWorktreePolicies[p];
    assure(scope.enabled===true&&scope.checks.includes('project-unit')
      &&scope.checks.includes('source-diff'),'PROJECT_POLICY_CHANGED_'+p);
  }
  const existing=Object.fromEntries(names.map((k,i)=>[k,current[i]]));
  for(const k of names)
    assure(sha(existing[k])===BASELINE[k],'LIVE_'+k.toUpperCase()+'_HASH_CHANGED');
  const desired=Object.fromEntries(await Promise.all(names.map(async k=>
    [k,await fs.readFile(paths.staged[k])]))
  );
  const src=Object.fromEntries(names.map(k=>[k,desired[k].toString('utf8')]));
  assure(src.server.includes('baseline_mode:{type:"string",enum:["local-main","remote-main"]}')
    &&src.server.includes('expected_local_main_sha:head'),
    'FRESH_ACTION_SCHEMA_MISSING');
  assure(src.initializer.includes("'remote-main'")&&
    src.initializer.includes("'REMOTE_MAIN_NOT_FAST_FORWARD'")&&
    src.initializer.includes("'fleet-v3-'"),'FRESH_BOOTSTRAP_GUARDS_MISSING');
  assure(src.coding.includes('["v1","v3"]')&&
    src.coding.includes('WORKTREE_LANE_CHANGED'),'FRESH_READER_GUARDS_MISSING');
  assure(src.helper.includes("const expectedLanes=['fleet-v1-','fleet-v3-']"),
    'SCOPED_WRITER_LANE_GUARDS_MISSING');
  for(const k of names)assure(sha(desired[k])!==BASELINE[k],
    'NEW_MODULE_IS_OLD_'+k.toUpperCase());
  return {existing,desired,newHashes:Object.fromEntries(names.map(k=>[k,sha(desired[k])])),
    summary:{status:'STAGED_V3_VALIDATED',nativeTools:13,
      projects:PROJECTS,remoteMain:'fetched refs/remotes/origin/main, SHA pinned, FF only',
      preservesV1:true,canonicalWritersEnabled:false,remoteGitWrites:false}};
}
async function create(file,data){
  let handle;
  try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(data);await handle.sync();}
  finally{if(handle)await handle.close();}
  assure((await fs.readFile(file)).equals(data),'WRITE_READBACK_MISMATCH');
}
async function replace(file,data){
  const temp=path.join(path.dirname(file),'.revenue-fleet-v3-'+randomUUID()+'.tmp');
  try{
    await create(temp,data);
    await fs.rename(temp,file);
  }finally{await fs.unlink(temp).catch(()=>{});}
  assure((await fs.readFile(file)).equals(data),'REPLACE_READBACK_MISMATCH');
}
export async function install(paths,{apply=false}={}){
  const snapshot=await inspect(paths);
  if(!apply)return {...snapshot.summary,oldHashes:BASELINE,
    newHashes:snapshot.newHashes,dryRun:true};
  assure(process.stdin.isTTY&&process.env.REVENUE_ACTION_OWNER_APPROVAL==='REVENUE_FLEET_V3',
    'INTERACTIVE_OWNER_APPROVAL_REQUIRED');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  let answer;
  try{answer=await rl.question('Type APPROVE REVENUE FLEET V3 to activate: ');}
  finally{rl.close();}
  assure(answer==='APPROVE REVENUE FLEET V3','OWNER_DECLINED_FLEET_V3');
  const names=Object.keys(FILES);
  for(const k of names)
    assure(sha(await fs.readFile(paths.live[k]))===BASELINE[k],
      'PREWRITE_CONCURRENT_MODULE_CHANGE_'+k);
  assure(sha(await fs.readFile(paths.config))===BASELINE.config,
    'PREWRITE_CONFIG_CHANGED');
  const backup=path.join(paths.backup,'fleet-v3-backup-'+Date.now());
  await fs.mkdir(backup,{recursive:false});
  for(const k of names)await create(path.join(backup,k+'.before'),snapshot.existing[k]);
  const replaced=[];
  try{
    for(const k of names){replaced.push(k);await replace(paths.live[k],snapshot.desired[k]);}
    for(const k of names)assure(sha(await fs.readFile(paths.live[k]))===
      snapshot.newHashes[k],'POSTWRITE_SHA_FAILED_'+k);
    const receipt={status:'INSTALLED_NOT_RELOADED',backup,
      oldHashes:BASELINE,newHashes:snapshot.newHashes,utc:new Date().toISOString(),
      summary:snapshot.summary};
    await create(path.join(backup,'installation-receipt.json'),
      Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
    return receipt;
  }catch(e){
    for(const k of replaced.reverse()){
      await replace(paths.live[k],snapshot.existing[k]);
    }
    throw e;
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const action=process.argv[2];
  if(!['--check','--apply'].includes(action)){
    console.error('Usage: prepare-revenue-fleet-v3.mjs --check|--apply');
    process.exitCode=2;
  }else{
    const home=process.env.USERPROFILE;
    const checkout=path.resolve(path.dirname(process.argv[1]),'..');
    install(pathsFor(home,checkout),{apply:action==='--apply'})
      .then(x=>console.log(JSON.stringify(x,null,2)))
      .catch(e=>{console.error(e.message);process.exitCode=1;});
  }
}
