import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createResearchInbox} from './fleet-research-inbox.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'revenue-research-test-'));
  const inbox=path.join(root,'revenue-shot-research');
  const src=path.join(root,'source-geo');
  const src2=path.join(root,'source-gsc');
  await fs.mkdir(inbox);await fs.mkdir(src);await fs.mkdir(src2);
  await fs.writeFile(path.join(src,'sentinel.txt'),'CANONICAL SOURCE UNMODIFIED\n');
  const config={enableResearchInbox:true,researchInboxRoot:inbox,
    projects:{geo:src,gsc:src2}};
  const task={
    project:'geo',issue_key:'anthropic-batch-citations',
    run_key:'geo-research-20261102T1700',
    priority:'P1',confidence:'HIGH',
    title:'Distinguish search-backed and ungrounded batch citations',
    problem:'The batch model omits search retrieval and its output cannot count as grounded URL evidence.',
    impact:'Customer-facing visibility metrics can overstate the strength of citation evidence.',
    action:'Trace which batch outputs reach the report and label ungrounded values when applicable.',
    validation:'Use a local offline mocked batch response and verify the report labels both evidence modes.',
    evidence:['src/core/anthropic.ts:87 at known main SHA c539916f',
      'https://developers.openai.com/api/docs/guides/tools-web-search']
  };
  return {root,inbox,src,config,task,api:createResearchInbox(config)};
}
async function cleanup(f){await fs.rm(f.root,{recursive:true,force:true});}

test('missing inbox is observable without creating any file',async()=>{
  const f=await fixture();
  try{
    const r=await f.api.read_research_tasks({project:'geo'});
    assert.equal(r.count,0);assert.equal(r.tasksFilePresent,false);
    assert.deepEqual(await fs.readdir(f.inbox),[]);
    assert.equal(await fs.readFile(path.join(f.src,'sentinel.txt'),'utf8'),
      'CANONICAL SOURCE UNMODIFIED\n');
  }finally{await cleanup(f);}
});

test('one evidence-backed proposal generates readable local tasks.txt and stable state',async()=>{
  const f=await fixture();
  try{
    const r=await f.api.propose_research_task(f.task);
    assert.equal(r.status,'QUEUED_FOR_HUMAN_REVIEW');
    const text=await fs.readFile(path.join(f.inbox,'tasks.txt'),'utf8');
    const state=JSON.parse(await fs.readFile(path.join(f.inbox,'tasks.json'),'utf8'));
    assert.equal(state.version,1);assert.equal(state.items.length,1);
    assert.equal(state.items[0].id,r.id);
    assert.equal(state.items[0].status,'OPEN');
    assert.match(text,/PROPOSALS ONLY/);
    assert.match(text,/Distinguish search-backed/);
    assert.match(text,/src\/core\/anthropic\.ts:87/);
    assert.match(text,/Verification plan:/);
    assert.equal(sha(text),r.tasksSha256);
    assert.equal(await fs.readFile(path.join(f.src,'sentinel.txt'),'utf8'),
      'CANONICAL SOURCE UNMODIFIED\n');
    assert.equal((await fs.readdir(f.inbox)).filter(x=>x.includes('.lock')).length,0);
  }finally{await cleanup(f);}
});

test('same issue key cannot create a duplicate or rewrite existing tasks',async()=>{
  const f=await fixture();
  try{
    await f.api.propose_research_task(f.task);
    const before=await fs.readFile(path.join(f.inbox,'tasks.txt'));
    const duplicate=await f.api.propose_research_task({...f.task,
      title:'Another headline for the same underlying issue'});
    assert.equal(duplicate.status,'DUPLICATE_NOT_MODIFIED');
    assert.deepEqual(await fs.readFile(path.join(f.inbox,'tasks.txt')),before);
    assert.equal((await f.api.read_research_tasks()).count,1);
  }finally{await cleanup(f);}
});

test('only two new research findings per project per UTC day, other project independent',async()=>{
  const f=await fixture();
  try{
    await f.api.propose_research_task(f.task);
    await f.api.propose_research_task({...f.task,issue_key:'anthropic-result-labeling',
      run_key:'geo-research-20261102T1800'});
    await assert.rejects(f.api.propose_research_task({...f.task,
      issue_key:'third-similar-issue',
      run_key:'geo-research-20261102T1900'}),/PROJECT_DAILY_RESEARCH_LIMIT/);
    const gsc=await f.api.propose_research_task({...f.task,
      project:'gsc',issue_key:'weekly-host-path-alias',
      run_key:'gsc-research-20261102T1900',evidence:['src/digest.ts:88 at GSC main']});
    assert.equal(gsc.status,'QUEUED_FOR_HUMAN_REVIEW');
    assert.equal((await f.api.read_research_tasks()).count,3);
  }finally{await cleanup(f);}
});

test('invalid project, unsafe IDs, non-concrete evidence and control characters are refused',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.api.propose_research_task({...f.task,
      project:'../other'}),/UNKNOWN_RESEARCH_PROJECT/);
    await assert.rejects(f.api.propose_research_task({...f.task,
      issue_key:'../../history'}),/INVALID_ISSUE_KEY/);
    await assert.rejects(f.api.propose_research_task({...f.task,
      evidence:['A vague finding without any locator']}),/EVIDENCE_LACKS_CONCRETE_LOCATOR/);
    await assert.rejects(f.api.propose_research_task({...f.task,
      priority:'sudo'}),/INVALID_RESEARCH_RANK/);
    assert.deepEqual(await fs.readdir(f.inbox),[]);
    await f.api.propose_research_task({...f.task,
      title:'Harmless first line\nSecond line task label'});
    const state=JSON.parse(await fs.readFile(path.join(f.inbox,'tasks.json'),'utf8'));
    assert.equal(state.items[0].title,'Harmless first line Second line task label');
  }finally{await cleanup(f);}
});

test('an outside lock blocks another writer rather than deleting its lock',async()=>{
  const f=await fixture();
  try{
    await fs.writeFile(path.join(f.inbox,'.tasks.lock'),'OTHER WRITER\n');
    await assert.rejects(f.api.propose_research_task(f.task),/RESEARCH_INBOX_BUSY/);
    assert.equal(await fs.readFile(path.join(f.inbox,'.tasks.lock'),'utf8'),
      'OTHER WRITER\n');
    assert.equal((await f.api.read_research_tasks()).count,0);
  }finally{await cleanup(f);}
});

test('source checkout directory cannot be used as research queue root',async()=>{
  const f=await fixture();
  try{
    const unsafe=path.join(f.src,'revenue-shot-research');
    await fs.mkdir(unsafe);
    const api=createResearchInbox({...f.config,researchInboxRoot:unsafe});
    await assert.rejects(api.propose_research_task(f.task),/INBOX_INSIDE_SOURCE_CHECKOUT/);
  }finally{await cleanup(f);}
});

test('state identity mismatch is not repaired by silently overwriting history',async()=>{
  const f=await fixture();
  try{
    await f.api.propose_research_task(f.task);
    const file=path.join(f.inbox,'tasks.json');
    const state=JSON.parse(await fs.readFile(file,'utf8'));
    state.items[0].id='000000000000';
    await fs.writeFile(file,JSON.stringify(state));
    await assert.rejects(f.api.propose_research_task({
      ...f.task,issue_key:'another-item'}),/INBOX_STATE_IDENTITY_MISMATCH/);
    assert.equal((await fs.readFile(file,'utf8')).includes('000000000000'),true);
  }finally{await cleanup(f);}
});
