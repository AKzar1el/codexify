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
const worktreeId=value=>sha(Buffer.from(process.platform==='win32'?
  path.resolve(value).toLowerCase():path.resolve(value))).slice(0,20);
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
test('fresh remote-main v3 lane retains canonical main and previously edited v1 lane',async()=>{
 const f=await fresh('nofax');
 try{
  const init=createFleetWorktreeInitializer(f.config);
  const old=await init.create_scoped_worktree(f.args);
  const oldSource=path.join(old.worktree,'src','source.ts');
  await fs.writeFile(oldSource,'export const answer = 9;\n');
  await cmd(f.repo,'checkout','-b','fixture-new-remote-main');
  await fs.writeFile(f.source,'export const answer = 2;\n');
  await cmd(f.repo,'add','src/source.ts');
  await cmd(f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test',
    'commit','-m','remote main advances');
  const upstream=await cmd(f.repo,'rev-parse','HEAD');
  await cmd(f.repo,'update-ref','refs/remotes/origin/main',upstream);
  await cmd(f.repo,'checkout','main');
  assert.equal(await cmd(f.repo,'rev-parse','refs/heads/main'),f.head);
  const params={...f.args,baseline_mode:'remote-main',
    expected_main_sha:upstream,expected_local_main_sha:f.head};
  const plan=await init.plan_scoped_worktree(params);
  assert.equal(plan.baselineMode,'remote-main');
  assert.equal(plan.localBaseSha,upstream);
  assert.equal(plan.canonicalMainSha,f.head);
  assert.equal(plan.branch,'revenue-shot/fleet-v3-nofax-root');
  assert.equal(await fs.stat(plan.newWorktree).then(()=>true).catch(()=>false),false);
  const created=await init.create_scoped_worktree(params);
  assert.equal(created.status,'CREATED_AND_VERIFIED');
  assert.equal(created.head,upstream);
  assert.equal(await fs.readFile(oldSource,'utf8'),'export const answer = 9;\n');
  assert.equal((await fs.readFile(f.source,'utf8')).replace(/\r\n/g,'\n'),
    'export const answer = 1;\n');
  assert.equal((await fs.readFile(path.join(created.worktree,'src/source.ts'),'utf8')).replace(/\r\n/g,'\n'),
    'export const answer = 2;\n');
  assert.equal(await cmd(f.repo,'rev-parse','refs/heads/main'),f.head);
  const id=worktreeId(created.worktree);
  const scoped=createScopedWorktreeActions(f.config);
  const scope={project:'nofax',repository:'root',worktree_id:id,
    expected_head:upstream,path:'src/source.ts',
    expected_journal_sha256:f.ledger,expected_state_sha256:f.state};
  const pre=await scoped.preflight_worktree_action(scope);
  const edit=await scoped.apply_scoped_worktree_edit({...scope,
    run_key:'remote-main-fixture-v3-001',expected_sha256:pre.sha256,
    find:'answer = 2',replacement:'answer = 3'});
  assert.equal(edit.status,'WORKTREE_EDIT_VERIFIED');
  const diff=await scoped.run_scoped_worktree_check({...scope,
    run_key:'remote-main-fixture-v3-001',check_id:'source-diff'});
  const unit=await scoped.run_scoped_worktree_check({...scope,
    run_key:'remote-main-fixture-v3-001',check_id:'project-unit'});
  assert.equal(diff.status,'CHECK_PASSED',JSON.stringify(diff));
  assert.equal(unit.status,'CHECK_PASSED',JSON.stringify(unit));
  f.config.coding.nofax.readPrefixes=['src/'];
  const readerRoot=path.join(f.temp,'reader-v3');
  await fs.mkdir(readerRoot);
  await fs.copyFile(path.join(process.cwd(),'scripts','fleet-ledger-test-fixture.mjs'),path.join(readerRoot,'ledger.mjs'));
  await fs.copyFile(path.join(process.cwd(),'scripts','fleet-coding-reader-v2.mjs'),
    path.join(readerRoot,'coding.mjs'));
  const {createCodingService}=await import(pathToFileURL(
    path.join(readerRoot,'coding.mjs')).href);
  const reader=createCodingService(f.config);
  const entries=await reader.inspect_project_worktrees({project:'nofax',repository:'root'});
  assert.equal(entries.worktrees.find(item=>item.id===id).readable,true);
  const readback=await reader.read_project_worktree_file({
    project:'nofax',repository:'root',worktree_id:id,
    path:'src/source.ts',offset:0,limit:12
  });
  assert.match(readback.content,/answer = 3/);
  assert.equal(readback.worktree_id,id);
  assert.equal(await fs.readFile(oldSource,'utf8'),'export const answer = 9;\n');
  assert.equal((await fs.readFile(f.source,'utf8')).replace(/\r\n/g,'\n'),
    'export const answer = 1;\n');
  assert.equal((await fs.stat(path.join(f.receiptRoot,'nofax',
    'bootstrap-root-remote-v3','result.json'))).isFile(),true);
 }finally{await fs.rm(f.temp,{recursive:true,force:true})}
});
test('fresh remote-main v3 refuses non-FF remote, wrong local SHA and stale remote SHA',async()=>{
 const f=await fresh('geo');
 try{
  const service=createFleetWorktreeInitializer(f.config);
  const args={...f.args,baseline_mode:'remote-main',
    expected_local_main_sha:f.head};
  await assert.rejects(service.plan_scoped_worktree(args),
    /REMOTE_MAIN_REF_NOT_FETCHED|Command failed/);
  await cmd(f.repo,'update-ref','refs/remotes/origin/main',f.head);
  await assert.rejects(service.plan_scoped_worktree({
    ...args,expected_main_sha:'0'.repeat(40)
  }),/BASELINE_SHA_MISMATCH/);
  await assert.rejects(service.plan_scoped_worktree({
    ...args,expected_main_sha:f.head,expected_local_main_sha:'0'.repeat(40)
  }),/CANONICAL_MAIN_PRECONDITION_CHANGED/);
  await cmd(f.repo,'checkout','--orphan','independent-remote');
  await cmd(f.repo,'rm','-rf','.');
  await fs.writeFile(path.join(f.repo,'standalone.txt'),'unrelated\n');
  await cmd(f.repo,'add','standalone.txt');
  await cmd(f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test',
    'commit','-m','unrelated remote');
  const other=await cmd(f.repo,'rev-parse','HEAD');
  await cmd(f.repo,'update-ref','refs/remotes/origin/main',other);
  await cmd(f.repo,'checkout','main');
  await assert.rejects(service.plan_scoped_worktree({
    ...args,expected_main_sha:other
  }),/REMOTE_MAIN_NOT_FAST_FORWARD/);
 }finally{await fs.rm(f.temp,{recursive:true,force:true})}
});
test('edited source in new lane passes only operator-allowlisted source-diff check',async()=>{
 const f=await fresh();
 try{
  const init=createFleetWorktreeInitializer(f.config);
  const lane=await init.create_scoped_worktree(f.args);
  const id=worktreeId(lane.worktree);
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
  const id=worktreeId(lane.worktree);
  const tempModule=path.join(f.temp,'module');
  await fs.mkdir(tempModule);
  await fs.copyFile(path.join(process.cwd(),'scripts','fleet-ledger-test-fixture.mjs'),
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
  const id=worktreeId(lane.worktree);
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
test('read-only receipt inspector preserves missing, successful, failed and tampered evidence',async()=>{
  const f=await fresh('nofax');
  try{
    const lane=await createFleetWorktreeInitializer(f.config).create_scoped_worktree(f.args);
    const id=worktreeId(lane.worktree);
    const action=createScopedWorktreeActions(f.config);
    const params={project:'nofax',repository:'root',worktree_id:id,
      expected_head:lane.head,path:'src/source.ts',
      expected_journal_sha256:f.ledger,expected_state_sha256:f.state,
      run_key:'receipt-readonly-20261102-01'};
    const missing=await action.inspect_scoped_worktree_receipts(params);
    assert.equal(missing.status,'NOT_RECORDED');
    assert.equal(missing.intentPresent,false);
    const pathToRun=path.join(f.receiptRoot,'nofax',id,
      sha(Buffer.from(params.run_key)).slice(0,32));
    await assert.rejects(fs.stat(pathToRun),{code:'ENOENT'});
    const initial=await action.preflight_worktree_action(params);
    await action.apply_scoped_worktree_edit({...params,
      expected_sha256:initial.sha256,find:'answer = 1',replacement:'answer = 2'});
    const incompleteCheck=await action.inspect_scoped_worktree_receipts(params);
    assert.equal(incompleteCheck.status,'EDIT_RECEIPT_VERIFIED');
    assert.deepEqual(incompleteCheck.checks,{});
    assert.equal(incompleteCheck.exclusiveWriterVerified,false);
    const sourceDiff=await action.run_scoped_worktree_check({...params,check_id:'source-diff'});
    const unit=await action.run_scoped_worktree_check({...params,check_id:'project-unit'});
    assert.equal(sourceDiff.status,'CHECK_PASSED');
    assert.equal(unit.status,'CHECK_PASSED');
    const before=await fs.readFile(path.join(pathToRun,'check-project-unit.json'));
    const inspected=await action.inspect_scoped_worktree_receipts(params);
    assert.equal(inspected.status,'EDIT_RECEIPT_VERIFIED');
    assert.equal(inspected.checks['source-diff'].status,'CHECK_PASSED');
    assert.equal(inspected.checks['project-unit'].status,'CHECK_PASSED');
    assert.equal(inspected.checks['project-unit'].receiptSha256,sha(before));
    assert.equal(inspected.externalEffectsVerified,false);
    assert.deepEqual(await fs.readFile(path.join(pathToRun,'check-project-unit.json')),before);
    const stored=JSON.parse(before.toString('utf8'));
    stored.status='CHECK_FAILED';
    await fs.writeFile(path.join(pathToRun,'check-project-unit.json'),
      JSON.stringify(stored)+'\n');
    const failed=await action.inspect_scoped_worktree_receipts(params);
    assert.equal(failed.checks['project-unit'].status,'CHECK_FAILED');
    assert.equal(failed.status,'EDIT_RECEIPT_VERIFIED');
    stored.sourceSha256='0'.repeat(64);
    await fs.writeFile(path.join(pathToRun,'check-project-unit.json'),
      JSON.stringify(stored)+'\n');
    const tampered=await action.inspect_scoped_worktree_receipts(params);
    assert.equal(tampered.status,'RECEIPT_IDENTITY_MISMATCH');
    assert.equal(tampered.checks['project-unit'].status,'INVALID_RECEIPT_IDENTITY');
    await assert.rejects(action.inspect_scoped_worktree_receipts({...params,
      run_key:'../unsafe'}),/INVALID_RUN_KEY/);
    await assert.rejects(action.inspect_scoped_worktree_receipts({...params,
      expected_journal_sha256:'0'.repeat(64)}),/CANONICAL_ACCOUNTING_CHANGED/);
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
