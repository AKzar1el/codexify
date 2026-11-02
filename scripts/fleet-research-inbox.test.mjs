import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createResearchInbox,ownerReviewResearchTask} from './fleet-research-inbox.mjs';

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
    assert.equal(r.projectTaskFile,'geo/tasks.txt');
    const scoped=await fs.readFile(path.join(f.inbox,'geo','tasks.txt'),'utf8');
    const other=await fs.readFile(path.join(f.inbox,'gsc','tasks.txt'),'utf8');
    assert.match(scoped,/Distinguish search-backed/);
    assert.doesNotMatch(other,/Distinguish search-backed/);
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
      run_key:'geo-research-20261102T1815'});
    assert.equal(duplicate.status,'DUPLICATE_NOT_MODIFIED');
    assert.deepEqual(await fs.readFile(path.join(f.inbox,'tasks.txt')),before);
    assert.equal((await f.api.read_research_tasks()).count,1);
  }finally{await cleanup(f);}
});

test('new evidence refines the same task and preserves each prior revision',async()=>{
  const f=await fixture();
  try{
    const first=await f.api.propose_research_task(f.task);
    const before=await fs.readFile(path.join(f.inbox,'tasks.json'));
    const revision=await f.api.propose_research_task({...f.task,
      run_key:'geo-research-20261102T1810',
      problem:'Offline batch results lack tool-based grounding while live search includes citations.',
      action:'Mark batch results as ungrounded and add an evidence provenance enum.',
      evidence:[...f.task.evidence,'src/core/tools.ts:91 at new reviewed HEAD']});
    assert.equal(revision.status,'TASK_REFINED');
    assert.equal(revision.id,first.id);
    assert.equal(revision.revision,2);
    const state=JSON.parse(await fs.readFile(path.join(f.inbox,'tasks.json'),'utf8'));
    assert.equal(state.items.length,1);
    assert.equal(state.items[0].history.length,2);
    assert.equal(state.items[0].history[0].kind,'CREATED');
    assert.equal(state.items[0].history[1].kind,'REFINED');
    assert.equal(state.items[0].history[1].previous.action,f.task.action);
    assert.equal(state.items[0].created,JSON.parse(before).items[0].created);
    const history=await fs.readFile(path.join(f.inbox,'geo','history.txt'),'utf8');
    assert.match(history,/Previous action: Trace which batch outputs/);
    assert.match(history,/changed: problem, action, evidence/);
    const userFacing=await fs.readFile(path.join(f.inbox,'geo','tasks.txt'),'utf8');
    assert.match(userFacing,/Revision: 2/);
    assert.match(userFacing,/Mark batch results as ungrounded/);
    const duplicate=await f.api.propose_research_task({...f.task,
      run_key:'geo-research-20261102T1815',
      problem:'Offline batch results lack tool-based grounding while live search includes citations.',
      action:'Mark batch results as ungrounded and add an evidence provenance enum.',
      evidence:[...f.task.evidence,'src/core/tools.ts:91 at new reviewed HEAD']});
    assert.equal(duplicate.status,'DUPLICATE_NOT_MODIFIED');
    const reused=await f.api.propose_research_task({...f.task,
      run_key:'geo-research-20261102T1810',
      action:'Silently rewrite the task with a recycled run key'});
    assert.equal(reused.status,'RUN_KEY_REUSED_DIFFERENT_CONTENT');
    assert.equal((await f.api.read_research_tasks()).count,1);
  }finally{await cleanup(f);}
});

test('interrupted view write is repaired by exact duplicate replay without a second task',async()=>{
  const f=await fixture();
  try{
    await f.api.propose_research_task(f.task);
    const state=await fs.readFile(path.join(f.inbox,'tasks.json'));
    await fs.unlink(path.join(f.inbox,'geo','tasks.txt'));
    const r=await f.api.propose_research_task(f.task);
    assert.equal(r.status,'DUPLICATE_VIEW_RECOVERED');
    assert.deepEqual(await fs.readFile(path.join(f.inbox,'tasks.json')),state);
    assert.match(await fs.readFile(path.join(f.inbox,'geo','tasks.txt'),'utf8'),
      /Distinguish search-backed/);
    assert.equal((await f.api.read_research_tasks()).count,1);
  }finally{await cleanup(f);}
});

test('no daily cap: several same-day actionable findings and independent projects',async()=>{
  const f=await fixture();
  try{
    for(let i=0;i<8;i++){
      const result=await f.api.propose_research_task({...f.task,
        issue_key:'anthropic-finding-'+String(i).padStart(2,'0'),
        run_key:'geo-research-20261102-'+i});
      assert.equal(result.status,'QUEUED_FOR_HUMAN_REVIEW');
    }
    const gsc=await f.api.propose_research_task({...f.task,
      project:'gsc',issue_key:'weekly-host-path-alias',
      run_key:'gsc-research-20261102T1900',evidence:['src/digest.ts:88 at GSC main']});
    assert.equal(gsc.status,'QUEUED_FOR_HUMAN_REVIEW');
    assert.equal((await f.api.read_research_tasks()).count,9);
    const history=await fs.readFile(path.join(f.inbox,'history.txt'),'utf8');
    assert.match(history,/anthropic-finding-07/);
    const gscHistory=await fs.readFile(path.join(f.inbox,'gsc','history.txt'),'utf8');
    assert.doesNotMatch(gscHistory,/anthropic-finding-07/);
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

test('human-only CAS review approves, completes and cannot be invoked by the scheduled MCP service',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(Object.keys(f.api).sort(),
      ['propose_research_task','read_research_tasks']);
    const entry=await f.api.propose_research_task(f.task);
    const source=await fs.readFile(path.join(f.inbox,'tasks.json'));
    const review=await ownerReviewResearchTask(f.config,{
      id:entry.id,status:'APPROVED',expected_state_sha256:sha(source)});
    assert.equal(review.status,'APPROVED');
    let text=await fs.readFile(path.join(f.inbox,'tasks.txt'),'utf8');
    assert.match(text,/Status: APPROVED/);
    assert.match(await fs.readFile(path.join(f.inbox,'geo','tasks.txt'),'utf8'),
      /Status: APPROVED/);
    assert.match(text,/\[>\] \[P1\]/);
    await assert.rejects(ownerReviewResearchTask(f.config,{
      id:entry.id,status:'DONE',expected_state_sha256:sha(source)}),
      /OWNER_REVIEW_STATE_CHANGED/);
    const updated=await fs.readFile(path.join(f.inbox,'tasks.json'));
    const finish=await ownerReviewResearchTask(f.config,{
      id:entry.id,status:'DONE',expected_state_sha256:sha(updated)});
    const history=await fs.readFile(path.join(f.inbox,'geo','history.txt'),'utf8');
    assert.match(history,/OWNER_STATUS/);
    assert.match(history,/Owner status: APPROVED -> DONE/);
    assert.equal(finish.status,'DONE');
    text=await fs.readFile(path.join(f.inbox,'tasks.txt'),'utf8');
    assert.doesNotMatch(text,/Distinguish search-backed/);
    assert.doesNotMatch(await fs.readFile(path.join(f.inbox,'geo','tasks.txt'),'utf8'),
      /Distinguish search-backed/);
    const duplicate=await f.api.propose_research_task(f.task);
    assert.equal(duplicate.status,'DUPLICATE_NOT_MODIFIED');
    await assert.rejects(ownerReviewResearchTask(f.config,{
      id:entry.id,status:'APPROVED',
      expected_state_sha256:finish.stateSha256}),/REVIEW_FINAL_STATUS_IMMUTABLE/);
    assert.equal(await fs.readFile(path.join(f.src,'sentinel.txt'),'utf8'),
      'CANONICAL SOURCE UNMODIFIED\n');
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
