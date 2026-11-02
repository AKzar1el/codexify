// Fixed-root, research-only task inbox for the six Revenue Shot workers.
// Writes only tasks.json and its derived tasks.txt; never edits repositories,
// canonical Revenue Shot journals, scheduled tasks or release state.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const PROJECTS=new Set(['geo','godprompt','gsc','nofax','trendpulse','webvalidator']);
const PRIORITIES=new Set(['P0','P1','P2','P3']);
const CONFIDENCE=new Set(['HIGH','MEDIUM']);
const STATUSES=new Set(['OPEN','APPROVED','DEFERRED','DONE','REJECTED']);
const KEY=/^[a-z][a-z0-9-]{3,79}$/;
const RUN=/^[A-Za-z0-9_.:+-]{8,160}$/;
const VERSION=1;
const MAX_OPEN=36;
const MAX_PER_DAY=2;
const MAX_ITEMS=200;
const sha=value=>createHash('sha256').update(value).digest('hex');
const deny=code=>{const e=new Error(code);e.code=code;throw e;};
const samePath=(a,b)=>process.platform==='win32'
  ?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase()
  :path.resolve(a)===path.resolve(b);
const within=(parent,child)=>{
  const rel=path.relative(parent,child);
  return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
};
const clean=(value,max,field)=>{
  if(typeof value!=='string')deny('INVALID_'+field);
  const text=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(text.length<12||text.length>max)deny('INVALID_'+field);
  return text;
};
async function fixedRoot(config){
  if(config?.enableResearchInbox!==true)deny('RESEARCH_INBOX_DISABLED');
  const root=config?.researchInboxRoot;
  if(typeof root!=='string'||!path.isAbsolute(root))deny('INBOX_ROOT_NOT_CONFIGURED');
  const fixed=path.resolve(root);
  if(path.basename(fixed).toLowerCase()!=='revenue-shot-research')
    deny('INBOX_ROOT_NOT_FIXED');
  for(const projectRoot of Object.values(config.projects??{})){
    if(typeof projectRoot==='string'&&path.isAbsolute(projectRoot)&&
       within(path.resolve(projectRoot),fixed))deny('INBOX_INSIDE_SOURCE_CHECKOUT');
  }
  const stat=await fs.lstat(fixed);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(await fs.realpath(fixed),fixed))
    deny('INBOX_ROOT_REDIRECTED');
  return fixed;
}
async function fileBytes(root,name){
  const file=path.join(root,name);
  let stat;
  try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)
    deny('INBOX_FILE_UNSAFE');
  return fs.readFile(file);
}
async function current(root){
  const data=await fileBytes(root,'tasks.json');
  if(!data)return {version:VERSION,items:[]};
  let obj;
  try{obj=JSON.parse(data.toString('utf8'));}catch{deny('INBOX_STATE_INVALID_JSON');}
  if(!obj||obj.version!==VERSION||!Array.isArray(obj.items)||
     obj.items.length>MAX_ITEMS)deny('INBOX_STATE_SCHEMA_CHANGED');
  for(const item of obj.items){
    if(!PROJECTS.has(item.project)||!KEY.test(item.issue_key)||
       !STATUSES.has(item.status)||typeof item.id!=='string')
      deny('INBOX_STATE_SCHEMA_CHANGED');
    if(item.id!==sha(item.project+'|'+item.issue_key).slice(0,12))
      deny('INBOX_STATE_IDENTITY_MISMATCH');
  }
  const ids=obj.items.map(i=>i.id);
  if(new Set(ids).size!==ids.length)deny('INBOX_DUPLICATE_STATE_IDS');
  return obj;
}
async function atomic(root,name,bytes){
  const file=path.join(root,name),temp=path.join(root,'.inbox-'+randomUUID()+'.tmp');
  let handle;
  try{
    handle=await fs.open(temp,'wx',0o600);
    await handle.writeFile(bytes);
    await handle.sync();await handle.close();handle=null;
    // Same-directory replacement. On failure, leave the previous index intact.
    await fs.rename(temp,file);
    if(!(await fs.readFile(file)).equals(bytes))deny('INBOX_READBACK_FAILED');
  }finally{
    if(handle)await handle.close();
    await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
}
async function withLock(root,operation){
  const file=path.join(root,'.tasks.lock');
  let lock;
  try{lock=await fs.open(file,'wx',0o600);}
  catch(e){if(e.code==='EEXIST')deny('RESEARCH_INBOX_BUSY');throw e;}
  try{
    await lock.writeFile(JSON.stringify({pid:process.pid,utc:new Date().toISOString()})+'\n');
    await lock.sync();
    return await operation();
  }finally{await lock.close();await fs.unlink(file);}
}
function render(state){
  const active=state.items.filter(i=>i.status==='OPEN'||i.status==='APPROVED');
  const order={P0:0,P1:1,P2:2,P3:3};
  active.sort((a,b)=>order[a.priority]-order[b.priority]||
    a.created.localeCompare(b.created)||a.project.localeCompare(b.project));
  const out=[
    'REVENUE SHOT - RESEARCH TASKS (review queue)',
    '===========================================',
    'PROPOSALS ONLY. No changes are implemented by adding an item here.',
    'Generated from tasks.json. Treat tasks.txt as read-only; discuss task IDs with the owner.',
    'Open: '+active.length+' | Total retained: '+state.items.length,
    ''
  ];
  for(const item of active){
    out.push('['+(item.status==='APPROVED'?'x':' ')+'] ['+item.priority+'] ['+
      item.project.toUpperCase()+'] '+item.id+' - '+item.title);
    out.push('Status: '+item.status+' | Confidence: '+item.confidence+
      ' | First seen: '+item.created.slice(0,10));
    out.push('Why it matters: '+item.impact);
    out.push('Problem: '+item.problem);
    out.push('Evidence:');
    for(const evidence of item.evidence)out.push('  - '+evidence);
    out.push('Proposed implementation: '+item.action);
    out.push('Verification plan: '+item.validation);
    out.push('Source run: '+item.run_key);
    out.push('');
  }
  if(!active.length)out.push('No actionable research tasks are currently queued.','');
  return out.join('\n')+'\n';
}
function validate(config,input){
  const project=input?.project;
  if(!PROJECTS.has(project)||!Object.hasOwn(config.projects??{},project))
    deny('UNKNOWN_RESEARCH_PROJECT');
  const issue_key=input?.issue_key;
  if(typeof issue_key!=='string'||!KEY.test(issue_key))deny('INVALID_ISSUE_KEY');
  if(!RUN.test(input?.run_key??''))deny('INVALID_RUN_KEY');
  const priority=input?.priority,confidence=input?.confidence;
  if(!PRIORITIES.has(priority)||!CONFIDENCE.has(confidence))deny('INVALID_RESEARCH_RANK');
  if(!Array.isArray(input.evidence)||input.evidence.length<1||input.evidence.length>4)
    deny('INVALID_EVIDENCE');
  const evidence=input.evidence.map(value=>clean(value,500,'EVIDENCE'));
  if(!evidence.some(value=>/https:\/\/|[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|py|md|astro|json|yaml|yml)(?::[0-9]+)?/i.test(value)))
    deny('EVIDENCE_LACKS_CONCRETE_LOCATOR');
  return {
    id:sha(project+'|'+issue_key).slice(0,12),project,issue_key,
    title:clean(input.title,120,'TITLE'),
    problem:clean(input.problem,700,'PROBLEM'),
    impact:clean(input.impact,400,'IMPACT'),
    action:clean(input.action,700,'ACTION'),
    validation:clean(input.validation,600,'VALIDATION'),
    evidence,priority,confidence,run_key:input.run_key
  };
}
export function createResearchInbox(config){
  return {
    async read_research_tasks(args={}){
      const root=await fixedRoot(config),state=await current(root);
      const visible=state.items.filter(i=>!args.project||i.project===args.project);
      return {readOnly:true,rootConfigured:true,version:VERSION,
        count:visible.length,open:visible.filter(i=>i.status==='OPEN').length,
        items:visible.slice(-50).map(i=>({id:i.id,project:i.project,status:i.status,
          priority:i.priority,title:i.title,created:i.created})),
        tasksFilePresent:!!(await fileBytes(root,'tasks.txt')),
        note:'Read-only summary; no code execution or owner approval implied.'};
    },
    async propose_research_task(args){
      const root=await fixedRoot(config),candidate=validate(config,args);
      return withLock(root,async()=>{
        const state=await current(root);
        if(state.items.some(i=>i.id===candidate.id)){
          return {status:'DUPLICATE_NOT_MODIFIED',id:candidate.id,
            taskFile:'tasks.txt',codeModified:false};
        }
        if(state.items.length>=MAX_ITEMS||
           state.items.filter(i=>i.status==='OPEN').length>=MAX_OPEN)
          deny('RESEARCH_BACKLOG_REVIEW_REQUIRED');
        const now=new Date().toISOString(),today=now.slice(0,10);
        const todayCount=state.items.filter(i=>
          i.project===candidate.project&&i.created?.startsWith(today)).length;
        if(todayCount>=MAX_PER_DAY)deny('PROJECT_DAILY_RESEARCH_LIMIT');
        const next={version:VERSION,items:[...state.items,{
          ...candidate,status:'OPEN',created:now
        }]};
        const json=Buffer.from(JSON.stringify(next,null,2)+'\n','utf8');
        const readable=Buffer.from(render(next),'utf8');
        if(json.length>1024*1024||readable.length>1024*1024)
          deny('INBOX_SIZE_LIMIT');
        await atomic(root,'tasks.json',json);
        await atomic(root,'tasks.txt',readable);
        return {status:'QUEUED_FOR_HUMAN_REVIEW',id:candidate.id,
          tasksSha256:sha(readable),taskFile:'tasks.txt',codeModified:false,
          journalModified:false,project:candidate.project};
      });
    }
  };
}
