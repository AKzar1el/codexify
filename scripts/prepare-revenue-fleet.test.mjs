import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {prepare,pathsFor,install} from './prepare-revenue-fleet.mjs';

const exec=promisify(execFile);
const sha=b=>createHash('sha256').update(b).digest('hex');
const home=process.env.USERPROFILE;
const projects=['geo','godprompt','gsc','nofax','trendpulse','webvalidator'];
async function sources(){
 const p=pathsFor(home,path.resolve('.'));
 const [server,config,helper,fleet,init,fragment]=await Promise.all([
  fs.readFile(p.server,'utf8'),fs.readFile(p.config,'utf8'),
  fs.readFile(p.currentHelper),fs.readFile(p.sourceFleet),fs.readFile(p.sourceInit),
  fs.readFile(p.fragment,'utf8')
 ]);
 return {p,server,config,helper,fleet,init,fragment};
}
test('all six project keys enabled with project-specific aliases, source and test allowlists',async()=>{
 const s=await sources();
 const p=prepare(s.server,s.config,s.helper,s.fleet,s.init,s.fragment,home);
 const c=JSON.parse(p.config.toString('utf8'));
 assert.deepEqual(Object.keys(c.scopedWorktreePolicies).sort(),projects);
 assert.equal(c.enableWrites,false);
 assert.equal(c.enableCodingWrites,false);
 assert.equal(c.enableProjectChecks,false);
 assert.equal(c.enableCodingRead,true);
 for(const k of projects){
   const scope=c.scopedWorktreePolicies[k];
   assert.deepEqual(scope.writePrefixes,k==='godprompt'?['src/','bench/']:['src/']);
   assert.equal(scope.checks.includes('source-diff'),true);
   assert.equal(scope.branchPrefix,'revenue-shot/');
   assert.deepEqual(scope.allowedRepositories,k==='godprompt'?['primary','companion']:['root']);
 }
 assert.equal(c.scopedWorktreePolicies.gsc.checks.includes('launcher'),true);
 assert.equal(c.scopedWorktreePolicies.gsc.writeFiles[0],'scripts/glama-start.mjs');
 assert.equal(c.scopedWorktreePolicies.godprompt.writeFiles[0],'build.py');
});
test('host without interactive owner approval cannot install or replace sidecar',async()=>{
 const s=await sources();
 const before=await fs.readFile(s.p.server);
 await assert.rejects(install(s.p,home,{apply:true}),/INTERACTIVE_OWNER_APPROVAL_REQUIRED/);
 assert.deepEqual(await fs.readFile(s.p.server),before);
 assert.equal(await fs.stat(s.p.targetFleet).then(()=>true).catch(()=>false),false);
 assert.equal(await fs.stat(s.p.targetInit).then(()=>true).catch(()=>false),false);
});
test('MCP action types are truthful and all six real project bootstraps plan read-only',async()=>{
 const s=await sources();
 const p=prepare(s.server,s.config,s.helper,s.fleet,s.init,s.fragment,home);
 const tmp=await fs.mkdtemp(path.join(process.cwd(),'.fleet-mcp-test-'));
 try{
   const side=path.dirname(s.p.server);
   for(const filename of ['ledger.mjs','coding.mjs']){
     await fs.copyFile(path.join(side,filename),path.join(tmp,filename));
   }
   await fs.writeFile(path.join(tmp,'server.mjs'),p.server);
   await fs.writeFile(path.join(tmp,'fleet-scoped-worktree-actions.mjs'),p.fleetHelper);
   await fs.writeFile(path.join(tmp,'fleet-worktree-init.mjs'),p.initHelper);
   const mod=await import(pathToFileURL(path.join(tmp,'server.mjs')).href);
   const config=JSON.parse(p.config.toString('utf8'));
   const handler=mod.makeHandler(config);
   const listed=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
   assert.equal(listed.result.tools.length,13);
   const lookup=name=>listed.result.tools.find(v=>v.name===name);
   assert.equal(lookup('plan_scoped_worktree').annotations.readOnlyHint,true);
   assert.equal(lookup('create_scoped_worktree').annotations.readOnlyHint,false);
   assert.equal(lookup('apply_scoped_worktree_edit').annotations.readOnlyHint,false);
   assert.equal(lookup('run_scoped_worktree_check').annotations.readOnlyHint,false);
   for(const name of ['append_run_record','apply_project_edit','run_project_check'])
     assert.equal(Boolean(lookup(name)),false);
   const summary=[];
   for(const [project,repoAlias] of [
     ['geo','root'],['godprompt','primary'],['godprompt','companion'],
     ['gsc','root'],['nofax','root'],['trendpulse','root'],['webvalidator','root']]){
     const root=config.projects[project];
     const gitRepo=path.resolve(root,config.coding[project].gitRoots[repoAlias]);
     const rev=(await exec('git',['-C',gitRepo,'rev-parse','refs/heads/main'],
       {windowsHide:true,timeout:8000})).stdout.trim();
     const journal=sha(await fs.readFile(path.join(root,'.revenue-shot','RUN_JOURNAL.md')));
     const state=sha(await fs.readFile(path.join(root,'.revenue-shot','CURRENT_STATE.md')));
     const call=await handler({jsonrpc:'2.0',id:1,method:'tools/call',
       params:{name:'plan_scoped_worktree',arguments:{
         project,repository:repoAlias,expected_main_sha:rev,
         expected_journal_sha256:journal,expected_state_sha256:state
       }}});
     assert.equal(call.result?.isError,false,
       project+': '+JSON.stringify(call.result).slice(0,350));
     assert.equal(call.result.structuredContent.project,project);
     assert.equal(call.result.structuredContent.readOnly,true);
     summary.push(project+'/'+repoAlias);
   }
   assert.deepEqual(summary,[
    'geo/root','godprompt/primary','godprompt/companion','gsc/root',
    'nofax/root','trendpulse/root','webvalidator/root']);
 }finally{await fs.rm(tmp,{recursive:true,force:true})}
});
test('changed source and privilege expansion cannot pass preparation',async()=>{
 const s=await sources();
 assert.throws(()=>prepare(s.server+'\n',s.config,s.helper,s.fleet,s.init,s.fragment,home),
   /CURRENT_GSC_CANARY_BASELINE_CHANGED/);
 assert.throws(()=>prepare(s.server,s.config.replace('"enableWrites": false','"enableWrites": true'),
   s.helper,s.fleet,s.init,s.fragment,home),
   /CURRENT_GSC_CANARY_BASELINE_CHANGED/);
});
