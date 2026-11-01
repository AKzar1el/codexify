import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepare,inspect,install,pathsFor} from './prepare-revenue-fleet-v2.mjs';

const home=process.env.USERPROFILE;
const checkout=path.resolve('.');
const paths=pathsFor(home,checkout);

test('v2 dry-run preserves canonical write gates and adds real project test policy',async()=>{
 const x=await inspect(paths);
 const cfg=JSON.parse(x.planned.config.toString('utf8'));
 for(const project of ['geo','godprompt','gsc','nofax','trendpulse','webvalidator']){
  assert.equal(cfg.scopedWorktreePolicies[project].checks.includes('project-unit'),true);
 }
 assert.equal(cfg.enableWrites,false);
 assert.equal(cfg.enableCodingWrites,false);
 assert.equal(cfg.enableProjectChecks,false);
 assert.equal(cfg.enableCodingRead,true);
 assert.notEqual(x.after.coding,x.after.helper);
 assert.equal(x.planned.details.nativeToolCount,13);
});

test('noninteractive activation cannot write to production files',async()=>{
 const before=await fs.readFile(paths.coding);
 await assert.rejects(install(paths,{apply:true}),/INTERACTIVE_HOST_APPROVAL_REQUIRED/);
 assert.deepEqual(await fs.readFile(paths.coding),before);
});

test('generated sidecar reads exact registered external NoFax source without widening paths',async()=>{
 const x=await inspect(paths);
 const dir=await fs.mkdtemp(path.join(checkout,'.fleet-v2-mcp-test-'));
 try{
  await fs.copyFile(path.join(paths.side,'ledger.mjs'),path.join(dir,'ledger.mjs'));
  await fs.copyFile(path.join(paths.side,'fleet-worktree-init.mjs'),path.join(dir,'fleet-worktree-init.mjs'));
  for(const name of ['server','config','coding','helper']){
   const to=name==='server'?'server.mjs':
     name==='config'?'config.json':
     name==='coding'?'coding.mjs':'fleet-scoped-worktree-actions.mjs';
   await fs.writeFile(path.join(dir,to),x.planned[name]);
  }
  const {makeHandler}=await import(pathToFileURL(path.join(dir,'server.mjs')).href);
  const config=JSON.parse(x.planned.config.toString('utf8'));
  const handler=makeHandler(config);
  const listed=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.equal(listed.result.tools.length,13);
  const check=listed.result.tools.find(x=>x.name==='run_scoped_worktree_check');
  assert.deepEqual(check.inputSchema.properties.check_id.enum,
    ['source-diff','launcher','project-unit']);
  const request={project:'nofax',repository:'root',
    worktree_id:'f5d6dfa0b545a76e80df',
    path:'src/mcp-tools.mjs',offset:280,limit:40};
  const result=await handler({jsonrpc:'2.0',id:2,method:'tools/call',
    params:{name:'read_project_worktree_file',arguments:request}});
  assert.equal(result.result.isError,false,JSON.stringify(result).slice(0,350));
  assert.equal(result.result.structuredContent.worktree_id,request.worktree_id);
  assert.match(result.result.structuredContent.content,/confirmationStatus/);
  const denied=await handler({jsonrpc:'2.0',id:3,method:'tools/call',
    params:{name:'read_project_worktree_file',arguments:{...request,path:'.env'}}});
  assert.equal(denied.result.isError,true);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('fixed project unit suite filenames actually exist for all seven repositories',async()=>{
 const x=await inspect(paths);
 const cfg=JSON.parse(x.planned.config.toString('utf8'));
 const suites=[
  ['geo','root','tests/matching.test.ts'],
  ['godprompt','primary','bench/tests/test_policy.py'],
  ['godprompt','companion','tests/normalize-mcpb.test.mjs'],
  ['gsc','root','tests/launcher.test.mjs'],
  ['nofax','root','test/mcp-tools.test.mjs'],
  ['trendpulse','root','tests/test_article_url_validation.py'],
  ['webvalidator','root','test/report.test.js']
 ];
 for(const [project,repository,source] of suites){
  const root=cfg.projects[project];
  const repoPath=path.resolve(root,cfg.coding[project].gitRoots[repository]);
  const stat=await fs.stat(path.join(repoPath,source));
  assert.equal(stat.isFile(),true,project+'/'+repository);
 }
});
