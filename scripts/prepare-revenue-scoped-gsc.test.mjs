import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {prepare,pathsFor} from './prepare-revenue-scoped-gsc.mjs';

const home=process.env.USERPROFILE;
const sha=v=>createHash('sha256').update(v).digest('hex');
async function source(){
  assert.ok(home,'Windows user profile required');
  const files=pathsFor(home,path.resolve('.'));
  const [server,config,helper,fragment]=await Promise.all([
    fs.readFile(files.server,'utf8'),fs.readFile(files.config,'utf8'),
    fs.readFile(files.helper),fs.readFile(files.fragment,'utf8')]);
  return {files,server,config,helper,fragment};
}
test('only GSC scoped actions enabled; legacy canonical writes and checks remain disabled',async()=>{
  const v=await source();
  const r=prepare(v.server,v.config,v.helper,v.fragment,home);
  const c=JSON.parse(r.config.toString('utf8'));
  assert.equal(c.enableWrites,false);
  assert.equal(c.enableCodingWrites,false);
  assert.equal(c.enableProjectChecks,false);
  assert.equal(c.enableCodingRead,true);
  assert.equal(c.enableScopedWorktreeActions,true);
  assert.deepEqual(Object.keys(c.scopedWorktreePolicies),['gsc']);
  assert.deepEqual(c.scopedWorktreePolicies.gsc.writeFiles,['scripts/glama-start.mjs']);
  assert.deepEqual(c.scopedWorktreePolicies.gsc.checks,['launcher']);
  assert.equal(r.server.toString('utf8').includes('run_scoped_worktree_check'),true);
});
test('new sidecar rejects changed baseline without writing anything',async()=>{
  const v=await source();
  assert.throws(()=>prepare(v.server+'\n',v.config,v.helper,v.fragment,home),
    /UNRECOGNIZED_PRODUCTION_BASELINE/);
  assert.throws(()=>prepare(v.server,v.config.replace('"enableWrites": false','"enableWrites": true'),
    v.helper,v.fragment,home),/UNRECOGNIZED_PRODUCTION_BASELINE/);
});
test('generated MCP server lists isolated write actions with truthful annotations',async()=>{
  const v=await source();
  const r=prepare(v.server,v.config,v.helper,v.fragment,home);
  const temp=await fs.mkdtemp(path.join(process.cwd(),'.scoped-gsc-test-'));
  try{
    const side=path.dirname(v.files.server);
    for(const name of ['ledger.mjs','coding.mjs']){
      await fs.copyFile(path.join(side,name),path.join(temp,name));
    }
    await fs.writeFile(path.join(temp,'server.mjs'),r.server);
    await fs.writeFile(path.join(temp,'scoped-worktree-actions.mjs'),r.helper);
    const {makeHandler}=await import(pathToFileURL(path.join(temp,'server.mjs')).href);
    const config=JSON.parse(r.config.toString('utf8'));
    const handler=makeHandler(config);
    const response=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
    const tools=response.result.tools;
    const get=n=>tools.find(t=>t.name===n);
    assert.equal(get('preflight_worktree_action').annotations.readOnlyHint,true);
    assert.equal(get('apply_scoped_worktree_edit').annotations.readOnlyHint,false);
    assert.equal(get('run_scoped_worktree_check').annotations.readOnlyHint,false);
    assert.equal(get('apply_scoped_worktree_edit').annotations.destructiveHint,true);
    assert.equal(Boolean(get('append_run_record')),false);
    assert.equal(Boolean(get('apply_project_edit')),false);
    assert.equal(Boolean(get('run_project_check')),false);
    const root=path.join(home,'Desktop','lol','mcp-gsc');
    const worktree=path.join(root,'.revenue-shot','worktrees','20261031-controller-pilot-port');
    const norm=path.resolve(worktree).toLowerCase();
    const worktree_id=sha(Buffer.from(norm)).slice(0,20);
    const journal=sha(await fs.readFile(path.join(root,'.revenue-shot','RUN_JOURNAL.md')));
    const state=sha(await fs.readFile(path.join(root,'.revenue-shot','CURRENT_STATE.md')));
    const p=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{
      name:'preflight_worktree_action',arguments:{
        project:'gsc',repository:'root',worktree_id,
        expected_head:'1849ec266394adde03409d8b0b008188c35182cb',
        path:'scripts/glama-start.mjs',expected_journal_sha256:journal,
        expected_state_sha256:state
      }}});
    assert.equal(p.result?.isError,false,JSON.stringify(p).slice(0,1200));
    assert.equal(p.result.structuredContent.path,'scripts/glama-start.mjs');
    assert.equal(p.result.structuredContent.readOnly,true);
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});
