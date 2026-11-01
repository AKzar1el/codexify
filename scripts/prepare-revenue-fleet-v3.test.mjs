import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inspect,install,pathsFor,BASELINE} from './prepare-revenue-fleet-v3.mjs';
const exec=promisify(execFile);
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const paths=pathsFor(process.env.USERPROFILE,path.resolve('.'));
test('v3 candidate has fixed remote main mode and preserves all canonical guards',async()=>{
 const x=await inspect(paths);
 assert.equal(x.summary.nativeTools,13);
 assert.equal(x.summary.canonicalWritersEnabled,false);
 assert.equal(x.summary.preservesV1,true);
 assert.equal(sha(await fs.readFile(paths.config)),BASELINE.config);
 for(const key of Object.keys(x.newHashes)){
  assert.notEqual(x.newHashes[key],BASELINE[key]);
 }
});
test('v3 refuses any noninteractive live sidecar activation',async()=>{
 const before=await fs.readFile(paths.live.server);
 await assert.rejects(install(paths,{apply:true}),
   /INTERACTIVE_OWNER_APPROVAL_REQUIRED/);
 assert.deepEqual(await fs.readFile(paths.live.server),before);
});
test('v3 generated MCP server has thirteen tools, two safe baseline modes, and legacy readback',async()=>{
 const x=await inspect(paths);
 const temp=await fs.mkdtemp(path.join(process.cwd(),'.fleet-v3-catalog-test-'));
 try{
  for(const file of ['ledger.mjs']){
   await fs.copyFile(path.join(paths.side,file),path.join(temp,file));
  }
  const files={server:'server.mjs',coding:'coding.mjs',
    helper:'fleet-scoped-worktree-actions.mjs',
    initializer:'fleet-worktree-init.mjs'};
  for(const [key,name] of Object.entries(files))
    await fs.writeFile(path.join(temp,name),x.desired[key]);
  const {makeHandler}=await import(pathToFileURL(path.join(temp,'server.mjs')).href);
  const config=JSON.parse(await fs.readFile(paths.config,'utf8'));
  const handler=makeHandler(config);
  const response=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.equal(response.result.tools.length,13);
  const p=response.result.tools.find(x=>x.name==='plan_scoped_worktree');
  const c=response.result.tools.find(x=>x.name==='create_scoped_worktree');
  assert.deepEqual(p.inputSchema.properties.baseline_mode.enum,
    ['local-main','remote-main']);
  assert.equal(c.inputSchema.properties.expected_local_main_sha.pattern,
    '^[a-f0-9]{40}$');
  assert.equal(p.annotations.readOnlyHint,true);
  assert.equal(c.annotations.readOnlyHint,false);
  const old=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{
    name:'read_project_worktree_file',arguments:{
      project:'nofax',repository:'root',
      worktree_id:'f5d6dfa0b545a76e80df',
      path:'test/mcp-tools.test.mjs',offset:0,limit:7}
  }});
  assert.equal(old.result.isError,false,JSON.stringify(old).slice(0,400));
  const repo=path.resolve(config.projects.godprompt,
    config.coding.godprompt.gitRoots.primary);
  const git=async(ref)=>(await exec('git',['-C',repo,'rev-parse',ref],
    {timeout:10000,windowsHide:true})).stdout.trim();
  const local=await git('refs/heads/main');
  const remote=await git('refs/remotes/origin/main');
  const base=config.projects.godprompt;
  const shaHex=b=>createHash('sha256').update(b).digest('hex');
  const journal=shaHex(await fs.readFile(path.join(base,'.revenue-shot','RUN_JOURNAL.md')));
  const state=shaHex(await fs.readFile(path.join(base,'.revenue-shot','CURRENT_STATE.md')));
  const args={project:'godprompt',repository:'primary',
    baseline_mode:'remote-main',expected_main_sha:remote,
    expected_local_main_sha:local,
    expected_journal_sha256:journal,expected_state_sha256:state};
  const plan=await handler({jsonrpc:'2.0',id:3,method:'tools/call',
    params:{name:'plan_scoped_worktree',arguments:args}});
  assert.equal(plan.result.isError,false,JSON.stringify(plan).slice(0,400));
  assert.equal(plan.result.structuredContent.baselineMode,'remote-main');
  assert.equal(plan.result.structuredContent.canonicalMainSha,local);
  assert.equal(plan.result.structuredContent.localBaseSha,remote);
  assert.match(plan.result.structuredContent.branch,/^revenue-shot\/fleet-v3-godprompt-primary$/);
  const bad=await handler({jsonrpc:'2.0',id:4,method:'tools/call',
    params:{name:'plan_scoped_worktree',arguments:{
      ...args,expected_local_main_sha:'0'.repeat(40)}}});
  assert.equal(bad.result.isError,true);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
