// Explicitly scoped worktree edits and checks for existing fixed project roots.
// No arbitrary shell, no canonical source writes, no Git push/merge/release.
// A host-approved MCP action is required for every effect; this module is not
// a global writer-ownership certificate or a bypass for denied host actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const KEY=/^[A-Za-z0-9_.:+-]{8,160}$/;
const SHA=/^[a-f0-9]{64}$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
// Fixed local unit-test commands. No agent-supplied executable, arguments,
// environment, network destination, or working directory is accepted.
const PROJECT_UNIT_PLANS=Object.freeze({
  'geo/root':{runtime:'node',cwd:'.',args:['--import','tsx','--test','tests/matching.test.ts']},
  'godprompt/primary':{runtime:'python',cwd:'bench',args:['-m','pytest','-q','-p','no:cacheprovider','tests/test_policy.py']},
  'godprompt/companion':{runtime:'node',cwd:'.',args:['--test','tests/normalize-mcpb.test.mjs']},
  'gsc/root':{runtime:'node',cwd:'.',args:['--test','tests/launcher.test.mjs']},
  'nofax/root':{runtime:'node',cwd:'.',args:['--test','test/mcp-tools.test.mjs']},
  'trendpulse/root':{runtime:'python',cwd:'.',args:['-m','pytest','-q','-p','no:cacheprovider','-m','not integration and not network and not browser','tests/test_article_url_validation.py']},
  'webvalidator/root':{runtime:'node',cwd:'.',args:['--test','test/report.test.js']}
});
const normal=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
function stop(code){const e=new Error(code);e.code=code;throw e;}
function within(parent,child){const relative=path.relative(parent,child);return relative && relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
function validateRel(rel){
  if(typeof rel!=='string'||rel.length===0||rel.length>220||rel.includes('\\')||rel.includes(':')||
     rel.startsWith('/')||rel.includes('\0'))stop('INVALID_RELATIVE_FILE');
  const parts=rel.split('/');
  if(parts.some(x=>!x||x==='.'||x==='..'||x.startsWith('.')||/^(secret|token|credential)s?$/i.test(x)))
    stop('DISALLOWED_FILE_COMPONENT');
  return rel;
}
async function safeDir(dir){
  const st=await fs.lstat(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||normal(await fs.realpath(dir))!==normal(dir))
    stop('UNSAFE_DIRECTORY');
}
async function safeFile(file,limit=1024*1024){
  const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>limit||normal(await fs.realpath(file))!==normal(file))
    stop('UNSAFE_FILE');
  const bytes=await fs.readFile(file);
  const after=await fs.lstat(file);
  if(bytes.length!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs)
    stop('FILE_CHANGED_DURING_READ');
  return bytes;
}
async function execGit(cwd,args){
  const {stdout}=await exec('git',['--no-optional-locks','-C',cwd,...args],
    {timeout:8000,windowsHide:true,maxBuffer:96*1024,env:{
      PATH:process.env.PATH||'',SYSTEMROOT:process.env.SYSTEMROOT||'',
      USERPROFILE:process.env.USERPROFILE||os.homedir(),HOME:process.env.HOME||os.homedir(),
      GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',CI:'1'}});
  return stdout.trim();
}
async function worktree(config,args){
  const project=args?.project,repo=args?.repository||'root';
  if(typeof project!=='string'||!Object.hasOwn(config.projects??{},project))
    stop('UNKNOWN_PROJECT');
  if(config.enableScopedWorktreeActions!==true)stop('SCOPED_WORKTREE_ACTIONS_DISABLED');
  const policy=config.scopedWorktreePolicies?.[project];
  if(!policy||policy.enabled!==true)stop('PROJECT_WORKTREE_ACTIONS_DISABLED');
  if(!Array.isArray(policy.writeFiles)||policy.writeFiles.length>20||
     !Array.isArray(policy.writePrefixes)||policy.writePrefixes.length>12||
     (policy.writeFiles.length===0&&policy.writePrefixes.length===0)||
     !Array.isArray(policy.checks)||policy.checks.length>12)
    stop('INVALID_PROJECT_OPERATOR_POLICY');
  const root=config.projects[project];
  if(typeof root!=='string'||!path.isAbsolute(root))stop('INVALID_FIXED_PROJECT_ROOT');
  await safeDir(root);
  const gitRel=config.coding?.[project]?.gitRoots?.[repo];
  if(typeof gitRel!=='string'||(gitRel!=='.'&&(gitRel.includes('..')||path.isAbsolute(gitRel))))
    stop('UNCONFIGURED_GIT_REPOSITORY');
  const gitRoot=path.resolve(root,gitRel);
  await safeDir(gitRoot);
  if((await execGit(gitRoot,['rev-parse','--show-toplevel'])).toLowerCase()!==gitRoot.replaceAll('\\','/').toLowerCase())
    stop('GIT_REPOSITORY_ROOT_MISMATCH');
  const targetId=args?.worktree_id;
  if(typeof targetId!=='string'||!/^[a-f0-9]{20}$/.test(targetId))stop('INVALID_WORKTREE_ID');
  const entries=(await execGit(gitRoot,['worktree','list','--porcelain'])).split(/\r?\n\r?\n/);
  let selected=null;
  for(const block of entries){
    const loc=block.match(/^worktree ([^\r\n]+)$/m)?.[1];
    if(!loc)continue;
    const digest=sha(Buffer.from(normal(loc))).slice(0,20);
    if(digest!==targetId)continue;
    selected={
      path:loc,head:block.match(/^HEAD ([a-f0-9]{40})$/m)?.[1],
      branch:block.match(/^branch refs\/heads\/([^\r\n]+)$/m)?.[1],
      locked:/^locked(?:\s|$)/m.test(block),prunable:/^prunable(?:\s|$)/m.test(block)
    };
  }
  if(!selected||!selected.head||!selected.branch||selected.locked||selected.prunable)
    stop('WORKTREE_UNAVAILABLE');
  const prefix=policy.branchPrefix;
  if(typeof prefix!=='string'||!prefix.startsWith('revenue-shot/')||!selected.branch.startsWith(prefix))
    stop('BRANCH_NOT_OPERATOR_ALLOWLISTED');
  // Preserve access to previously registered internal GSC lanes, but use
  // external maintenance storage for all NEW clean-slate fleet worktrees.
  const legacy=path.join(gitRoot,'.revenue-shot','worktrees');
  const externalRoot=config.fleetWorktreesRoot;
  const external=typeof externalRoot==='string'&&path.isAbsolute(externalRoot)
    ?path.join(externalRoot,project,repo):null;
  const isLegacy=within(gitRoot,selected.path)&&within(legacy,selected.path)&&
    normal(path.dirname(selected.path))===normal(legacy);
  const expectedLanes=['fleet-v1-','fleet-v3-'].map(prefix=>
    prefix+project+'-'+repo);
  const isExternal=external!==null&&within(external,selected.path)&&
    normal(path.dirname(selected.path))===normal(external)&&
    expectedLanes.some(suffix=>
      normal(selected.path)===normal(path.join(external,suffix))&&
      selected.branch==='revenue-shot/'+suffix);
  if(normal(selected.path)===normal(gitRoot)||(!isLegacy&&!isExternal))
    stop('WORKTREE_NOT_IN_FIXED_LANE');
  await safeDir(isLegacy?legacy:external);await safeDir(selected.path);
  const head=await execGit(selected.path,['rev-parse','HEAD']);
  if(head!==selected.head||head!==args?.expected_head)
    stop('WORKTREE_HEAD_CHANGED');
  const file=validateRel(args?.path);
  const prefixMatch=policy.writePrefixes.some(prefix=>
    typeof prefix==='string'&&prefix.endsWith('/')&&
    prefix.length>1&&validateRel(prefix.slice(0,-1))&&
    file.startsWith(prefix));
  if(!policy.writeFiles.includes(file)&&!prefixMatch)
    stop('FILE_NOT_OPERATOR_ALLOWLISTED');
  let current=selected.path;
  const parts=file.split('/');
  for(let i=0;i<parts.length;i++){
    current=path.join(current,parts[i]);
    if(i<parts.length-1)await safeDir(current);
  }
  const filePath=current;
  const bytes=await safeFile(filePath);
  const journal=await safeFile(path.join(root,'.revenue-shot','RUN_JOURNAL.md'),16*1024*1024);
  const state=await safeFile(path.join(root,'.revenue-shot','CURRENT_STATE.md'),16*1024*1024);
  if(sha(journal)!==args?.expected_journal_sha256||sha(state)!==args?.expected_state_sha256)
    stop('CANONICAL_ACCOUNTING_CHANGED');
  return {project,repository:repo,policy,root,gitRoot,worktree:selected.path,worktreeId:targetId,
    head,file,filePath,source:bytes,sourceSha256:sha(bytes),
    journalSha256:sha(journal),stateSha256:sha(state)};
}
async function projectUnitCheck(ctx) {
  const plan=PROJECT_UNIT_PLANS[ctx.project+'/'+ctx.repository];
  if(!plan)stop('PROJECT_UNIT_SUITE_NOT_CONFIGURED');
  const cwd=plan.cwd==='.'?ctx.worktree:path.join(ctx.worktree,plan.cwd);
  await safeDir(cwd);
  const executable=plan.runtime==='node'?process.execPath:'python';
  const env={
    PATH:process.env.PATH||'',Path:process.env.Path||process.env.PATH||'',
    PATHEXT:process.env.PATHEXT||'',SYSTEMROOT:process.env.SYSTEMROOT||'',
    SystemRoot:process.env.SystemRoot||process.env.SYSTEMROOT||'',
    USERPROFILE:process.env.USERPROFILE||os.homedir(),HOME:process.env.HOME||os.homedir(),
    TEMP:process.env.TEMP||os.tmpdir(),TMP:process.env.TMP||os.tmpdir(),
    CI:'1',NO_COLOR:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',
    PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1',GIT_TERMINAL_PROMPT:'0',
    npm_config_offline:'true',npm_config_ignore_scripts:'true'
  };
  if(ctx.project==='trendpulse')env.PYTHONPATH=path.join(ctx.worktree,'src');
  if(ctx.project==='godprompt'&&ctx.repository==='primary')
    env.PYTHONPATH=cwd;
  try {
    const {stdout,stderr}=await exec(executable,plan.args,{
      cwd,windowsHide:true,timeout:45000,maxBuffer:128*1024,env
    });
    return {passed:true,suite:ctx.project+'/'+ctx.repository,
      commandId:'fixed-project-unit',output:(stdout+stderr).slice(-2400)};
  }catch(e){
    return {passed:false,suite:ctx.project+'/'+ctx.repository,
      commandId:'fixed-project-unit',
      error:String(e.message).slice(0,350),
      output:String((e.stdout??'')+(e.stderr??'')).slice(-2400)};
  }
}
async function rootForRecords(config){
  const root=config.worktreeActionRecordsRoot;
  if(typeof root!=='string'||!path.isAbsolute(root))stop('ACTION_RECORDS_ROOT_NOT_CONFIGURED');
  await safeDir(root);
  return root;
}
async function recordDir(config,ctx,runKey) {
  if(!KEY.test(runKey??''))stop('INVALID_RUN_KEY');
  const root=await rootForRecords(config);
  const p=path.join(root,ctx.project,ctx.worktreeId);
  await fs.mkdir(p,{recursive:true});
  await safeDir(path.join(root,ctx.project));await safeDir(p);
  return path.join(p,sha(Buffer.from(runKey)).slice(0,32));
}
async function writeOnce(file,value){
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n','utf8');
  let h;try{h=await fs.open(file,'wx',0o600);await h.writeFile(bytes);await h.sync();}
  finally{if(h)await h.close();}
  if(!(await fs.readFile(file)).equals(bytes))stop('RECORD_READBACK_FAILED');
}
async function readJson(file){
  return JSON.parse((await safeFile(file,32*1024)).toString('utf8'));
}
async function acquire(dir,runKey){
  const file=path.join(dir,'owner.lock');
  let h;
  try{h=await fs.open(file,'wx',0o600);}
  catch(e){if(e.code==='EEXIST')stop('WORKTREE_WRITER_BUSY_OR_STALE');throw e;}
  await h.writeFile(JSON.stringify({runKey,pid:process.pid,utc:new Date().toISOString()})+'\n');await h.sync();
  return async()=>{await h.close();await fs.unlink(file);};
}
function identity(ctx,args){
  return sha(Buffer.from(JSON.stringify({
    project:ctx.project,worktreeId:ctx.worktreeId,head:ctx.head,
    path:ctx.file,expectedSource:args.expected_sha256,find:args.find,
    replacement:args.replacement,journal:ctx.journalSha256,state:ctx.stateSha256,
    runKey:args.run_key
  })));
}
function proposal(ctx,args){
  if(!SHA.test(args?.expected_sha256??'')||ctx.sourceSha256!==args.expected_sha256)
    stop('SOURCE_PRECONDITION_CHANGED');
  if(typeof args.find!=='string'||args.find.length===0||args.find.length>8192||
     typeof args.replacement!=='string'||args.replacement.length>8192||
     args.replacement.includes('\0'))stop('INVALID_SOURCE_PATCH');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(ctx.source);
  const first=text.indexOf(args.find);
  if(first<0||text.indexOf(args.find,first+args.find.length)>=0)
    stop('PATCH_CONTEXT_NOT_UNIQUE');
  const next=Buffer.from(text.slice(0,first)+args.replacement+text.slice(first+args.find.length));
  if(next.length>1024*1024)stop('PATCH_TOO_LARGE');
  return next;
}
export function createScopedWorktreeActions(config) {
  return {
    async preflight_worktree_action(args){
      // No mutation and no model-supplied filesystem root.
      const ctx=await worktree(config,args);
      return {project:ctx.project,worktree_id:ctx.worktreeId,
        head:ctx.head,path:ctx.file,sha256:ctx.sourceSha256,
        journalSha256:ctx.journalSha256,stateSha256:ctx.stateSha256,
        projectRootUnchanged:true,readOnly:true,
        note:'Read-only evidence, not owner exclusivity or permission to edit.'};
    },
    async read_scoped_worktree_source(args) {
      const ctx=await worktree(config,args);
      if(!SHA.test(args?.expected_sha256??'')||
         args.expected_sha256!==ctx.sourceSha256)stop('SOURCE_PRECONDITION_CHANGED');
      const offset=args.offset??0,limit=args.limit??80;
      if(!Number.isInteger(offset)||offset<0||offset>1000000||
         !Number.isInteger(limit)||limit<1||limit>180)stop('INVALID_READ_WINDOW');
      if(ctx.source.includes(0))stop('BINARY_SOURCE_NOT_ALLOWED');
      let contents;
      try{contents=new TextDecoder('utf-8',{fatal:true}).decode(ctx.source);}
      catch{stop('NON_UTF8_SOURCE_NOT_ALLOWED');}
      const lines=contents.split(/\r?\n/),selected=[];
      let bytes=0;
      for(let i=offset;i<Math.min(lines.length,offset+limit);i++){
        const next=Buffer.byteLength(lines[i],'utf8')+(selected.length?1:0);
        if(next>12000&&selected.length===0)stop('SOURCE_LINE_TOO_LARGE');
        if(bytes+next>12000)break;
        selected.push(lines[i]);bytes+=next;
      }
      return {project:ctx.project,repository:ctx.repository,
        worktree_id:ctx.worktreeId,head:ctx.head,path:ctx.file,
        sha256:ctx.sourceSha256,sourceBytes:ctx.source.length,
        offset,lines:lines.length,returnedLines:selected.length,
        nextOffset:offset+selected.length,truncated:offset+selected.length<lines.length,
        content:selected.join('\n'),readOnly:true};
    },
    async apply_scoped_worktree_edit(args){
      if(!KEY.test(args?.run_key??''))stop('INVALID_RUN_KEY');
      const ctx=await worktree(config,args);
      const fingerprint=identity(ctx,args);
      const runDir=await recordDir(config,ctx,args.run_key);
      // A completed idempotent result is usable only if the persisted receipt
      // and current file agree. Incomplete intents are never re-applied.
      try{
        const result=await readJson(path.join(runDir,'result.json'));
        if(result.fingerprint!==fingerprint||result.project!==ctx.project||
           result.worktree_id!==ctx.worktreeId||result.path!==ctx.file||
           result.expectedHead!==ctx.head||
           result.status!=='WORKTREE_EDIT_VERIFIED')
          stop('AMBIGUOUS_OR_TAMPERED_RECEIPT');
        const intent=await readJson(path.join(runDir,'intent.json'));
        if(intent.fingerprint!==fingerprint||intent.nextSha256!==result.newSha256||
           intent.sourceSha256!==args.expected_sha256||intent.project!==ctx.project)
          stop('INTENT_RECEIPT_MISMATCH');
        if(ctx.sourceSha256!==result.newSha256)stop('RESULT_SOURCE_DRIFT');
        return {...result,reused:true};
      }catch(e){if(e.code!=='ENOENT')throw e;}
      const next=proposal(ctx,args);
      const dir=path.dirname(runDir),release=await acquire(dir,args.run_key);
      let tmp=null;
      try{
        try{await fs.mkdir(runDir);}
        catch(e){if(e.code==='EEXIST')stop('INCOMPLETE_INTENT_NO_AUTO_REPLAY');throw e;}
        const intent={schema:'SCOPED_WORKTREE_ACTION_V1',project:ctx.project,runKey:args.run_key,
          worktreeId:ctx.worktreeId,expectedHead:ctx.head,file:ctx.file,
          sourceSha256:ctx.sourceSha256,nextSha256:sha(next),fingerprint,
          journalSha256:ctx.journalSha256,stateSha256:ctx.stateSha256,
          externalEffects:false,createdUtc:new Date().toISOString()};
        await writeOnce(path.join(runDir,'intent.json'),intent);
        // Check again immediately before change, then atomic same-directory rename.
        const fresh=await worktree(config,args);
        if(fresh.sourceSha256!==ctx.sourceSha256||fresh.head!==ctx.head)
          stop('PRE_EDIT_CONCURRENT_CHANGE');
        tmp=path.join(path.dirname(ctx.filePath),'.scoped-worktree-'+randomUUID()+'.tmp');
        let h;
        try{h=await fs.open(tmp,'wx',0o600);await h.writeFile(next);await h.sync();}
        finally{if(h)await h.close();}
        if(!(await fs.readFile(tmp)).equals(next))stop('STAGED_SOURCE_READBACK_FAILED');
        const again=await worktree(config,args);
        if(again.sourceSha256!==ctx.sourceSha256||again.head!==ctx.head)
          stop('CONCURRENT_SOURCE_CHANGED');
        await fs.rename(tmp,ctx.filePath);
        tmp=null;
        const after=await safeFile(ctx.filePath);
        if(!after.equals(next))stop('POST_EDIT_UNCERTAIN');
        const result={schema:'SCOPED_WORKTREE_ACTION_V1',status:'WORKTREE_EDIT_VERIFIED',
          project:ctx.project,worktree_id:ctx.worktreeId,run_key:args.run_key,
          path:ctx.file,expectedHead:ctx.head,previousSha256:ctx.sourceSha256,
          newSha256:sha(after),fingerprint,canonicalSourceTouched:false,
          externalEffects:false,hostApprovalRequired:true,utc:new Date().toISOString()};
        await writeOnce(path.join(runDir,'result.json'),result);
        return result;
      }finally{
        if(tmp)await fs.unlink(tmp).catch(()=>{});
        await release();
      }
    },
    async run_scoped_worktree_check(args){
      if(!KEY.test(args?.run_key??''))stop('INVALID_RUN_KEY');
      const ctx=await worktree(config,args);
      if(!ctx.policy.checks.includes(args?.check_id))stop('CHECK_NOT_OPERATOR_ALLOWLISTED');
      const runDir=await recordDir(config,ctx,args.run_key);
      const done=await readJson(path.join(runDir,'result.json'));
      if(done.status!=='WORKTREE_EDIT_VERIFIED'||done.project!==ctx.project||
         done.newSha256!==ctx.sourceSha256||done.run_key!==args.run_key)
        stop('MISSING_VERIFIED_EDIT_FOR_CHECK');
      const checkFile=path.join(runDir,'check-'+args.check_id+'.json');
      const legacy=path.join(runDir,'check.json');
      // Preserve/reuse old single-check receipts without overwriting them.
      try {
        const old=await readJson(legacy);
        if(old.check_id===args.check_id){
          if(old.sourceSha256!==ctx.sourceSha256)stop('LEGACY_CHECK_RECEIPT_DRIFT');
          return {...old,reused:true};
        }
      }catch(e){if(e.code!=='ENOENT')throw e;}
      try{
        const result=await readJson(checkFile);
        if(result.sourceSha256!==ctx.sourceSha256||result.check_id!==args.check_id)
          stop('CHECK_RECEIPT_TAMPERED');
        return {...result,reused:true};
      }catch(e){if(e.code!=='ENOENT')throw e;}
      const release=await acquire(path.dirname(runDir),args.run_key);
      try{
        // Deliberately no general command runner. Six-project baseline supports
        // local Git whitespace validation on one exact edited source. GSC
        // retains the preapproved launcher regression as a separate choice.
        let outcome={passed:false};
        if(args.check_id==='source-diff'&&
           ctx.policy.checks.includes('source-diff')&&
           (ctx.policy.checkCommand==='git-diff-check'||
            ctx.policy.checkCommands?.['source-diff']==='git-diff-check')){
          try{
            const output=await execGit(ctx.worktree,
              ['diff','--check','HEAD','--',ctx.file]);
            outcome={passed:output.length===0,output:output.slice(-2000)};
          }catch(e){outcome={passed:false,error:String(e.message).slice(0,300)};}
        }else if(ctx.project==='gsc'&&args.check_id==='launcher'&&
                 ctx.policy.checkCommand==='node-test-launcher'){
          try{
            const {stdout,stderr}=await exec(process.execPath,
              ['--test','tests/launcher.test.mjs'],{
                cwd:ctx.worktree,windowsHide:true,timeout:20000,maxBuffer:64*1024,
                env:{PATH:process.env.PATH||'',SYSTEMROOT:process.env.SYSTEMROOT||'',
                  USERPROFILE:process.env.USERPROFILE||os.homedir(),TEMP:process.env.TEMP||os.tmpdir(),
                  CI:'1'}});
            outcome={passed:stdout.includes('# fail 0')&&stdout.includes('# pass 5'),
              output:(stdout+stderr).slice(-2000)};
          }catch(e){outcome={passed:false,error:String(e.message).slice(0,300)};}
        }else if(args.check_id==='project-unit'&&
                 ctx.policy.checks.includes('project-unit')){
          outcome=await projectUnitCheck(ctx);
        }else stop('UNSUPPORTED_CHECK');
        const after=await worktree(config,args);
        if(after.sourceSha256!==ctx.sourceSha256||after.head!==ctx.head)
          stop('POST_CHECK_SOURCE_CHANGED');
        const result={schema:'SCOPED_WORKTREE_CHECK_V1',project:ctx.project,
          run_key:args.run_key,worktree_id:ctx.worktreeId,check_id:args.check_id,
          status:outcome.passed?'CHECK_PASSED':'CHECK_FAILED',
          sourceSha256:ctx.sourceSha256,head:ctx.head,
          output:outcome.output??null,error:outcome.error??null,
          externalEffects:false,utc:new Date().toISOString()};
        await writeOnce(checkFile,result);
        return result;
      }finally{await release();}
    }
  };
}
