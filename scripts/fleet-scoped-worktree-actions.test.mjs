import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFleetWorktreeInitializer} from './fleet-worktree-init.mjs';
import {createScopedWorktreeActions} from './fleet-scoped-worktree-actions.mjs';
import {pathToFileURL} from 'node:url';

const run=promisify(execFile);
const sha=b=>createHash('sha256').update(b).digest('hex');
async function cmd(cwd,...args){
 const r=await run('git',['-C',cwd,...args],{windowsHide:true,timeout:7000});
 return r.stdout.trim();
}
async function fresh(project='geo',alias='root'){
 const temp=await fs.mkdtemp(path.join(process.cwd(),'.fleet-scoped-test-'));
 const root=path.join(temp,'project');
 const repo=alias==='companion'?path.join(root,'god-prompt-mcp'):
   alias==='primary'?path.join(root,'god-prompt'):root;
 await fs.mkdir(path.join(repo,'src'),{recursive:true});
 if(project==='nofax'){
   await fs.mkdir(path.join(repo,'test'),{recursive:true});
   await fs.writeFile(path.join(repo,'test','mcp-tools.test.mjs'),
     "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixed suite',()=>assert.equal(2,1+1));\n");
 }
 await fs.mkdir(path.join(root,'.revenue-shot'),{recursive:true});
 const source=path.join(repo,'src','source.ts');
 await fs.writeFile(source,'export const answer = 1;\n','utf8');
 await fs.writeFile(path.join(root,'.revenue-shot','RUN_JOURNAL.md'),'RUN_KEY: old-record\n','utf8');
 await fs.writeFile(path.join(root,'.revenue-shot','CURRENT_STATE.md'),'STATUS: old-completed\n','utf8');
 await cmd(repo,'init','-b','main');
 await cmd(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test',
   'add','.');
 await cmd(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test',
   'commit','-m','fixture');
 const head=await cmd(repo,'rev-parse','HEAD');
 const ledger=sha(await fs.readFile(path.join(root,'.revenue-shot','RUN_JOURNAL.md')));
 const state=sha(await fs.readFile(path.join(root,'.revenue-shot','CURRENT_STATE.md')));
 const receiptRoot=path.join(temp,'receipts');
 await fs.mkdir(receiptRoot,{recursive:true});
 const fleetWorktreesRoot=path.join(temp,'fleet-worktrees');
 const config={
  projects:{[project]:root},
  coding:{[project]:{gitRoots:{[alias]:alias==='root'?'.':
    alias==='primary'?'god-prompt':'god-prompt-mcp'}}},
  enableScopedWorktreeActions:true,enableCodingRead:true,
  scopedWorktreePolicies:{[project]:{
    enabled:true,allowedRepositories:[alias],branchPrefix:'revenue-shot/',
    writeFiles:[],writePrefixes:['src/'],checks:['source-diff','project-unit'],
    checkCommand:'git-diff-check'
  }},
  worktreeActionRecordsRoot:receiptRoot,fleetWorktreesRoot
 };
 const args={project,repository:alias,expected_main_sha:head,
   expected_journal_sha256:ledger,expected_state_sha256:state};
 return {temp,root,repo,config,args,source,ledger,state,head,receiptRoot};
}
test('one clean disjoint worktree and durable receipts, never canonical edits',async()=>{
 const f=await fresh();
 try{
  const service=createFleetWorktreeInitializer(f.config);
  const plan=await service.plan_scoped_worktree(f.args);
  assert.equal(plan.readOnly,true);
  assert.equal(await fs.stat(plan.newWorktree).then(()=>true).catch(()=>false),false);
  const oldStatus=await cmd(f.repo,'status','--porcelain');
  const output=await service.create_scoped_worktree(f.args);
  assert.equal(output.status,'CREATED_AND_VERIFIED');
  assert.equal(output.head,f.head);
  assert.equal(await cmd(f.repo,'rev-parse','HEAD'),f.head);
  assert.equal((await fs.readFile(f.source,'utf8')),'export const answer = 1;\n');
  assert.equal((await cmd(f.repo,'status','--porcelain')),oldStatus);
  const intent=path.join(f.receiptRoot,'geo','bootstrap-root','intent.json');
  const result=path.join(f.receiptRoot,'geo','bootstrap-root','result.json');
  assert.equal(JSON.parse(await fs.readFile(intent,'utf8')).remoteEffectsAllowed,false);
  assert.equal(JSON.parse(await fs.readFile(result,'utf8')).status,'CREATED_AND_VERIFIED');
  await assert.rejects(service.create_scoped_worktree(f.args),
    /CLEAN_SLATE_WORKTREE_ALREADY_EXISTS/);
 }finally{await fs.rm(f.temp,{recursive:true,force:true})}
});
test('edited source in new lane passes only operator-allowlisted source-diff check',async()=>{
 const f=await fresh();
 try{
  const init=createFleetWorktreeInitializer(f.config);
  const lane=await init.create_scoped_worktree(f.args);
  const id=sha(Buffer.from(path.resolve(lane.worktree).toLowerCase())).slice(0,20);
  const edit=createScopedWorktreeActions(f.config);
  const params={project:'geo',repository:'root',worktree_id:id,
    expected_head:lane.head,path:'src/source.ts',
    expected_journal_sha256:f.ledger,expected_state_sha256:f.state};
  const pre=await edit.preflight_worktree_action(params);
  const modified=await edit.apply_scoped_worktree_edit({
    ...params,run_key:'fleet-test-geo-001',expected_sha256:pre.sha256,
    find:'answer = 1',replacement:'answer = 2'
  });
  assert.equal(modified.status,'WORKTREE_EDIT_VERIFIED');
  const result=await edit.run_scoped_worktree_check({
    ...params,run_key:'fleet-test-geo-001',check_id:'source-diff'
  });
  assert.equal(result.status,'CHECK_PASSED',JSON.stringify(result));
  assert.equal((await fs.readFile(f.source,'utf8')),'export const answer = 1;\n');
  assert.equal((await fs.readFile(path.join(lane.worktree,'src','source.ts'),'utf8')),
    'export const answer = 2;\n');
  await assert.rejects(edit.preflight_worktree_action({...params,path:'../escape'}),
    /DISALLOWED_FILE_COMPONENT/);
 }finally{await fs.rm(f.temp,{recursive:true,force:true})}
});
test('scoped readers inspect only the exact registered external lane with source SHA',async()=>{
 const f=await fresh('gsc');
 try{
  f.config.coding.gsc.readPrefixes=['src/'];
  const lane=await createFleetWorktreeInitializer(f.config).create_scoped_worktree(f.args);
  const id=sha(Buffer.from(path.resolve(lane.worktree).toLowerCase())).slice(0,20);
  const tempModule=path.join(f.temp,'module');
  await fs.mkdir(tempModule);
  await fs.copyFile(path.join(process.env.USERPROFILE,'.codexify','revenue-shot-direct-v041','ledger.mjs'),
    path.join(tempModule,'ledger.mjs'));
  await fs.copyFile(path.join(process.cwd(),'scripts','fleet-coding-reader-v2.mjs'),
    path.join(tempModule,'coding.mjs'));
  const {createCodingService}=await import(pathToFileURL(path.join(tempModule,'coding.mjs')).href);
  const original=createCodingService(f.config);
  const listing=await original.inspect_project_worktrees({project:'gsc',repository:'root'});
  assert.equal(listing.worktrees.find(x=>x.id===id).readable,true);
  const result=await original.read_project_worktree_file({
    project:'gsc',repository:'root',worktree_id:id,
    path:'src/source.ts',offset:0,limit:12
  });
  assert.match(result.content,/answer = 1/);
  assert.equal(result.worktree_id,id);
  await assert.rejects(original.read_project_worktree_file({
    project:'gsc',repository:'root',worktree_id:id,path:'../secret'
  }),/DISALLOWED_PATH_COMPONENT/);
  await assert.rejects(original.read_project_worktree_file({
    project:'gsc',repository:'root',worktree_id:id,path:'nonallowlisted/private.txt'
  }),/FILE_NOT_ALLOWLISTED/);
  const scoped=createScopedWorktreeActions(f.config);
  const params={project:'gsc',repository:'root',worktree_id:id,
    expected_head:lane.head,path:'src/source.ts',
    expected_journal_sha256:f.ledger,expected_state_sha256:f.state};
  const pre=await scoped.preflight_worktree_action(params);
  const window=await scoped.read_scoped_worktree_source({
    ...params,expected_sha256:pre.sha256,offset:0,limit:20
  });
  assert.match(window.content,/answer = 1/);
  assert.equal(window.readOnly,true);
  await assert.rejects(scoped.read_scoped_worktree_source({
    ...params,expected_sha256:'0'.repeat(64)
  }),/SOURCE_PRECONDITION_CHANGED/);
 }finally{await fs.rm(f.temp,{recursive:true,force:true})}
});
test('project-specific NoFax unit suite and git diff both record separate immutable checks',async()=>{
 const f=await fresh('nofax');
 try{
  const lane=await createFleetWorktreeInitializer(f.config).create_scoped_worktree(f.args);
  const id=sha(Buffer.from(path.resolve(lane.worktree).toLowerCase())).slice(0,20);
  const scoped=createScopedWorktreeActions(f.config);
  const params={project:'nofax',repository:'root',worktree_id:id,
    expected_head:lane.head,path:'src/source.ts',
    expected_journal_sha256:f.ledger,expected_state_sha256:f.state,
    run_key:'fleet-test-nofax-unit-002'};
  const pre=await scoped.preflight_worktree_action(params);
  const changed=await scoped.apply_scoped_worktree_edit({
    ...params,expected_sha256:pre.sha256,
    find:'answer = 1',replacement:'answer = 2'
  });
  assert.equal(changed.status,'WORKTREE_EDIT_VERIFIED');
  const diff=await scoped.run_scoped_worktree_check({...params,check_id:'source-diff'});
  assert.equal(diff.status,'CHECK_PASSED',JSON.stringify(diff));
  const unit=await scoped.run_scoped_worktree_check({...params,check_id:'project-unit'});
  assert.equal(unit.status,'CHECK_PASSED',JSON.stringify(unit));
  assert.match(unit.output,/pass/i);
  assert.equal((await scoped.run_scoped_worktree_check({...params,check_id:'project-unit'})).reused,true);
  const receiptDir=path.join(f.receiptRoot,'nofax',id,
    sha(Buffer.from(params.run_key)).slice(0,32));
  assert.equal(JSON.parse(await fs.readFile(path.join(receiptDir,'check-project-unit.json'),'utf8')).status,'CHECK_PASSED');
  assert.equal(JSON.parse(await fs.readFile(path.join(receiptDir,'check-source-diff.json'),'utf8')).status,'CHECK_PASSED');
 }finally{await fs.rm(f.temp,{recursive:true,force:true})}
});
test('all six scopes use fixed roots and cannot replace source or historical state',async()=>{
 for(const [project,alias] of [
  ['geo','root'],['godprompt','primary'],['godprompt','companion'],
  ['gsc','root'],['nofax','root'],['trendpulse','root'],['webvalidator','root']]){
  const f=await fresh(project,alias);
  try{
   const service=createFleetWorktreeInitializer(f.config);
   await assert.rejects(service.plan_scoped_worktree({
     ...f.args,expected_main_sha:'0'.repeat(40)
   }),/BASELINE_SHA_MISMATCH/);
   await assert.rejects(service.plan_scoped_worktree({
     ...f.args,expected_journal_sha256:'0'.repeat(64)
   }),/ACCOUNTING_PRECONDITION_CHANGED/);
   await assert.rejects(service.plan_scoped_worktree({
     ...f.args,repository:'malicious'
   }),/REPOSITORY_ALIAS_NOT_APPROVED/);
   const plan=await service.plan_scoped_worktree(f.args);
   assert.equal(plan.project,project);
   assert.equal(plan.branch,'revenue-shot/fleet-v1-'+project+'-'+alias);
  }finally{await fs.rm(f.temp,{recursive:true,force:true})}
 }
});
