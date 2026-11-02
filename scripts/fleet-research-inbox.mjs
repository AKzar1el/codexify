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
// No per-day, open-item, or total-item quotas. File size is a safety boundary.
const MAX_FILE_BYTES=32*1024*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const deny=code=>{const e=new Error(code);e.code=code;throw e;};
const nativePath=p=>{
  const unprefixed=process.platform==='win32'&&p.startsWith('\\\\?\\')
    ?p.slice(4):p;
  const canonical=path.resolve(unprefixed);
  return process.platform==='win32'?canonical.toLowerCase():canonical;
};
const samePath=(a,b)=>nativePath(a)===nativePath(b);
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
  // Windows filesystem prefixes, volume aliases and temporary junction parents
  // may change the realpath string. The operator pins the path in private config;
  // reject a redirected *inbox itself* without rejecting harmless parent aliases.
  if(!stat.isDirectory()||stat.isSymbolicLink()||
     (process.platform!=='win32'&&!samePath(await fs.realpath(fixed),fixed)))
    deny('INBOX_ROOT_REDIRECTED');
  return fixed;
}
async function fileBytes(root,name){
  const file=path.join(root,name);
  let stat;
  try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)
    deny('INBOX_FILE_UNSAFE');
  return fs.readFile(file);
}
async function current(root){
  const data=await fileBytes(root,'tasks.json');
  if(!data)return {version:VERSION,items:[]};
  let obj;
  try{obj=JSON.parse(data.toString('utf8'));}catch{deny('INBOX_STATE_INVALID_JSON');}
  if(!obj||obj.version!==VERSION||!Array.isArray(obj.items))deny('INBOX_STATE_SCHEMA_CHANGED');
  for(const item of obj.items){
    if(!PROJECTS.has(item.project)||!KEY.test(item.issue_key)||
       !STATUSES.has(item.status)||typeof item.id!=='string'||
       (item.history!==undefined&&!Array.isArray(item.history)))
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
function render(state,project=null){
  const scoped=project?state.items.filter(i=>i.project===project):state.items;
  const active=scoped.filter(i=>i.status==='OPEN'||i.status==='APPROVED');
  const order={P0:0,P1:1,P2:2,P3:3};
  active.sort((a,b)=>order[a.priority]-order[b.priority]||
    a.created.localeCompare(b.created)||a.project.localeCompare(b.project));
  const out=[
    project?'REVENUE SHOT - '+project.toUpperCase()+' RESEARCH TASKS':'REVENUE SHOT - RESEARCH TASKS (review queue)',
    '===========================================',
    'PROPOSALS ONLY. No changes are implemented by adding an item here.',
    'Generated from tasks.json. Treat tasks.txt as read-only; discuss task IDs with the owner.',
    'Open: '+active.length+' | Total retained: '+scoped.length,
    ''
  ];
  for(const item of active){
    out.push('['+(item.status==='APPROVED'?'>':' ')+'] ['+item.priority+'] ['+
      item.project.toUpperCase()+'] '+item.id+' - '+item.title);
    out.push('Status: '+item.status+' | Confidence: '+item.confidence+
      ' | First seen: '+item.created.slice(0,10)+
      ' | Updated: '+(item.updated??item.created).slice(0,10)+
      ' | Revision: '+(item.revision??1));
    out.push('Why it matters: '+item.impact);
    out.push('Problem: '+item.problem);
    out.push('Evidence:');
    for(const evidence of item.evidence)out.push('  - '+evidence);
    out.push('Proposed implementation: '+item.action);
    out.push('Verification plan: '+item.validation);
    out.push('Latest supporting run: '+item.run_key);
    out.push('Revision history: see history.txt in this folder.');
    out.push('');
  }
  if(!active.length)out.push('No actionable research tasks are currently queued.','');
  return out.join('\n')+'\n';
}
// Stable issue identity: a changed proposal refines its original task, rather
// than creating a competing duplicate. Historical evidence remains inspectable.
const SNAPSHOT_FIELDS=['title','problem','impact','action','validation',
  'evidence','priority','confidence','run_key'];
function snapshot(item){
  return Object.fromEntries(SNAPSHOT_FIELDS.map(field=>[field,item[field]]));
}
function contentDigest(item){
  return sha(JSON.stringify(SNAPSHOT_FIELDS.filter(x=>x!=='run_key')
    .map(field=>item[field])));
}
function historyOf(item){
  if(Array.isArray(item.history))return item.history;
  return [{kind:'CREATED',at:item.created,run_key:item.run_key,
    note:'Original preserved task; revisions before migration are unknown.'}];
}
function historyEvent(kind,now,runKey,detail={}){
  return {kind,at:now,run_key:runKey,...detail};
}
function changedFields(before,after){
  return SNAPSHOT_FIELDS.filter(field=>field!=='run_key'&&
    JSON.stringify(before[field])!==JSON.stringify(after[field]));
}
function renderHistory(state,project=null){
  const scoped=(project?state.items.filter(i=>i.project===project):state.items)
    .slice().sort((a,b)=>a.created.localeCompare(b.created));
  const out=[
    project?'REVENUE SHOT - '+project.toUpperCase()+' RESEARCH HISTORY':
      'REVENUE SHOT - COMPLETE RESEARCH TASK HISTORY',
    '================================================',
    'Audit trail: includes earlier revisions and owner status transitions.',
    'No entry is proof that the proposed code was implemented.',
    'Entries: '+scoped.length,''
  ];
  for(const item of scoped){
    out.push('['+item.project.toUpperCase()+'] '+item.id+' '+item.issue_key);
    out.push('Current: '+item.status+' | '+item.title+
      ' | Revision '+(item.revision??1));
    for(const event of historyOf(item)){
      out.push('  '+event.at+' '+event.kind+
        ' | run '+(event.run_key??'owner')+
        (event.fields?.length?' | changed: '+event.fields.join(', '):''));
      if(event.previous){
        out.push('    Previous title: '+event.previous.title);
        out.push('    Previous problem: '+event.previous.problem);
        out.push('    Previous impact: '+event.previous.impact);
        out.push('    Previous action: '+event.previous.action);
        out.push('    Previous validation: '+event.previous.validation);
        out.push('    Previous priority/confidence: '+event.previous.priority+
          '/'+event.previous.confidence);
        out.push('    Previous evidence: '+(event.previous.evidence??[]).join(' | '));
      }
      if(event.from||event.to)out.push('    Owner status: '+event.from+' -> '+event.to);
    }
    out.push('');
  }
  if(!scoped.length)out.push('No research proposals recorded yet.','');
  return out.join('\n')+'\n';
}
function ctxProjectTask(project){return project+'/tasks.txt';}
async function syncViews(root,state){
  // tasks.json is authoritative. All text files are derived review views.
  // A partial view write is repairable on a duplicate submission.
  const views=[[root,'tasks.txt',render(state)],
    [root,'history.txt',renderHistory(state)]];
  for(const project of PROJECTS){
    const dir=path.join(root,project);
    try{await fs.mkdir(dir);}
    catch(e){if(e.code!=='EEXIST')throw e;}
    const stat=await fs.lstat(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())deny('PROJECT_VIEW_PATH_UNSAFE');
    views.push([dir,'tasks.txt',render(state,project)],
      [dir,'history.txt',renderHistory(state,project)]);
  }
  let changed=false;
  for(const [dir,name,text] of views){
    const bytes=Buffer.from(text,'utf8');
    if(bytes.length>MAX_FILE_BYTES)deny('INBOX_CAPACITY_REACHED');
    const previous=await fileBytes(dir,name);
    if(!previous||!previous.equals(bytes)){
      await atomic(dir,name,bytes);
      changed=true;
    }
  }
  return {changed,aggregateSha256:sha(Buffer.from(views[0][2],'utf8'))};
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
// Owner review is a programmatic local capability only; it is deliberately NOT
// exposed as an MCP tool to unattended Revenue Shot workers.
export async function ownerReviewResearchTask(config,args){
  const id=args?.id,status=args?.status;
  if(typeof id!=='string'||!/^[a-f0-9]{12}$/.test(id))deny('INVALID_TASK_ID');
  if(!new Set(['APPROVED','DEFERRED','DONE','REJECTED']).has(status))
    deny('INVALID_REVIEW_STATUS');
  const expected=args?.expected_state_sha256;
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))
    deny('OWNER_REVIEW_CAS_REQUIRED');
  const root=await fixedRoot(config);
  return withLock(root,async()=>{
    const previous=await fileBytes(root,'tasks.json');
    if(!previous||sha(previous)!==expected)deny('OWNER_REVIEW_STATE_CHANGED');
    const state=await current(root);
    const item=state.items.find(i=>i.id===id);
    if(!item)deny('REVIEW_TASK_NOT_FOUND');
    if(item.status===status)return {id,status,reused:true};
    if(['DONE','REJECTED'].includes(item.status))deny('REVIEW_FINAL_STATUS_IMMUTABLE');
    const now=new Date().toISOString();
    const next={version:VERSION,items:state.items.map(i=>i.id===id?
      {...i,status,reviewed:now,
        history:[...historyOf(i),historyEvent('OWNER_STATUS',now,'owner',
          {from:i.status,to:status})]}:i)};
    const json=Buffer.from(JSON.stringify(next,null,2)+'\n','utf8');
    await atomic(root,'tasks.json',json);
    const views=await syncViews(root,next);
    return {id,status,reviewed:true,stateSha256:sha(json),tasksSha256:views.aggregateSha256};
  });
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
        const state=await current(root),now=new Date().toISOString();
        const existing=state.items.find(item=>item.id===candidate.id);
        if(existing){
          if(contentDigest(existing)===contentDigest(candidate)){
            const views=await syncViews(root,state);
            return {status:views.changed?'DUPLICATE_VIEW_RECOVERED':'DUPLICATE_NOT_MODIFIED',
              id:candidate.id,taskFile:'tasks.txt',
              projectTaskFile:ctxProjectTask(candidate.project),
              tasksSha256:views.aggregateSha256,codeModified:false};
          }
          if(['DONE','REJECTED'].includes(existing.status)){
            return {status:'CLOSED_TASK_UNCHANGED',id:candidate.id,
              note:'An unattended worker cannot reopen an owner-closed task.'};
          }
          const history=historyOf(existing);
          if(existing.run_key===candidate.run_key||
             history.some(event=>event.run_key===candidate.run_key)){
            return {status:'RUN_KEY_REUSED_DIFFERENT_CONTENT',id:candidate.id,
              note:'No mutation; a research revision requires a genuinely new run key.'};
          }
          const fields=changedFields(existing,candidate);
          const updated={...existing,...snapshot(candidate),
            // Preserve owner state, original task identity and creation date.
            status:existing.status,updated:now,
            revision:(existing.revision??1)+1,
            history:[...history,historyEvent('REFINED',now,candidate.run_key,
              {fields,previous:snapshot(existing)})]};
          const next={...state,items:state.items.map(item=>
            item.id===candidate.id?updated:item)};
          const json=Buffer.from(JSON.stringify(next,null,2)+'\n','utf8');
          if(json.length>MAX_FILE_BYTES)deny('INBOX_CAPACITY_REACHED');
          await atomic(root,'tasks.json',json);
          const views=await syncViews(root,next);
          return {status:'TASK_REFINED',id:candidate.id,
            revision:updated.revision,changedFields:fields,
            tasksSha256:views.aggregateSha256,taskFile:'tasks.txt',
            projectTaskFile:ctxProjectTask(candidate.project),
            historyFile:'history.txt',codeModified:false};
        }
        const newTask={...candidate,status:'OPEN',created:now,updated:now,
          revision:1,history:[historyEvent('CREATED',now,candidate.run_key)]};
        const next={...state,items:[...state.items,newTask]};
        const json=Buffer.from(JSON.stringify(next,null,2)+'\n','utf8');
        if(json.length>MAX_FILE_BYTES)deny('INBOX_CAPACITY_REACHED');
        await atomic(root,'tasks.json',json);
        const views=await syncViews(root,next);
        return {status:'QUEUED_FOR_HUMAN_REVIEW',id:candidate.id,
          tasksSha256:views.aggregateSha256,taskFile:'tasks.txt',
          projectTaskFile:ctxProjectTask(candidate.project),
          historyFile:'history.txt',codeModified:false,
          journalModified:false,project:candidate.project};
      });

    }
  };
}
