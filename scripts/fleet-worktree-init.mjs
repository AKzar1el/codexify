// Owner-approved local worktree bootstrap for six fixed Revenue Shot repositories.
// No shell interpolation, remote fetch/push, protected-main modification, or
// historical journal replay. Host must approve the write-annotated action.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const call=promisify(execFile);
const hash=b=>createHash('sha256').update(b).digest('hex');
const SHA=/^[0-9a-f]{64}$/;
const norm=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
function deny(code){const e=new Error(code);e.code=code;throw e;}
async function safeDir(p){
  const s=await fs.lstat(p);
  if(!s.isDirectory()||s.isSymbolicLink()||norm(await fs.realpath(p))!==norm(p))
    deny('UNSAFE_DIRECTORY');
}
async function safeFile(p,limit=16*1024*1024){
  const s=await fs.lstat(p);
  if(!s.isFile()||s.isSymbolicLink()||s.size>limit)deny('UNSAFE_FILE');
  const v=await fs.readFile(p);
  const second=await fs.lstat(p);
  if(s.mtimeMs!==second.mtimeMs||s.size!==v.length)deny('RACE_IN_FILE_READ');
  return v;
}
async function git(repo,args,{write=false}={}){
  const env={
    PATH:process.env.PATH||'',SystemRoot:process.env.SystemRoot||process.env.SYSTEMROOT||'',
    HOME:process.env.HOME||process.env.USERPROFILE||'',USERPROFILE:process.env.USERPROFILE||'',
    GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:write?'1':'0',CI:'1'
  };
  const hooks=process.platform==='win32'?'NUL':'/dev/null';
  const safeArgs=['-c','core.hooksPath='+hooks,'-c','submodule.recurse=false',
    '-C',repo,...args];
  const result=await call('git',safeArgs,{
    timeout:20000,windowsHide:true,maxBuffer:32*1024,env});
  return result.stdout.trim();
}
function aliasFor(config,project,repository){
  const policy=config.scopedWorktreePolicies?.[project];
  if(config.enableScopedWorktreeActions!==true||policy?.enabled!==true)
    deny('PROJECT_SCOPE_NOT_ENABLED');
  if(!Array.isArray(policy.allowedRepositories)||
     !policy.allowedRepositories.includes(repository))
    deny('REPOSITORY_ALIAS_NOT_APPROVED');
  const root=config.projects?.[project];
  const rel=config.coding?.[project]?.gitRoots?.[repository];
  if(typeof root!=='string'||!path.isAbsolute(root)||
     typeof rel!=='string'||(rel!=='.'&&(rel.includes('..')||path.isAbsolute(rel))))
    deny('UNSAFE_REPO_BINDING');
  return {root,repo:path.resolve(root,rel),policy};
}
async function snapshot(config,args){
  const project=args?.project,repository=args?.repository;
  const ctx=aliasFor(config,project,repository);
  await safeDir(ctx.root);await safeDir(ctx.repo);
  const top=await git(ctx.repo,['rev-parse','--show-toplevel']);
  if(norm(top)!==norm(ctx.repo))deny('REPOSITORY_TOP_LEVEL_CHANGED');
  const baseline=await git(ctx.repo,['rev-parse','--verify','refs/heads/main']);
  if(!/^[a-f0-9]{40}$/.test(baseline)||baseline!==args?.expected_main_sha)
    deny('BASELINE_SHA_MISMATCH');
  if(!SHA.test(args?.expected_journal_sha256||'')||
     !SHA.test(args?.expected_state_sha256||''))deny('INVALID_ACCOUNTING_DIGEST');
  const journal=await safeFile(path.join(ctx.root,'.revenue-shot','RUN_JOURNAL.md'));
  const state=await safeFile(path.join(ctx.root,'.revenue-shot','CURRENT_STATE.md'));
  if(hash(journal)!==args.expected_journal_sha256||
     hash(state)!==args.expected_state_sha256)
    deny('ACCOUNTING_PRECONDITION_CHANGED');
  const suffix='fleet-v1-'+project+'-'+repository;
  const folder=path.join(ctx.repo,'.revenue-shot','worktrees');
  const target=path.join(folder,suffix);
  const branch='revenue-shot/'+suffix;
  if(await fs.stat(target).then(()=>true).catch(e=>
    e.code==='ENOENT'?false:Promise.reject(e)))
    deny('CLEAN_SLATE_WORKTREE_ALREADY_EXISTS');
  let branchExists=false;
  try{await git(ctx.repo,['show-ref','--verify','--quiet','refs/heads/'+branch]);branchExists=true;}
  catch(e){if(e.code!==1)throw e;}
  if(branchExists)deny('CLEAN_SLATE_BRANCH_ALREADY_EXISTS');
  return {project,repository,...ctx,baseline,branch,folder,target,
    journalSha256:hash(journal),stateSha256:hash(state)};
}
async function verifiedCreate(file,value){
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
  let h;try{h=await fs.open(file,'wx',0o600);await h.writeFile(bytes);await h.sync();}
  finally{if(h)await h.close();}
  if(!(await fs.readFile(file)).equals(bytes))deny('RECEIPT_READBACK_FAILED');
}
function receiptBase(config,ctx){
  const root=config.worktreeActionRecordsRoot;
  if(typeof root!=='string'||!path.isAbsolute(root))deny('RECEIPT_ROOT_UNSET');
  return path.join(root,ctx.project,'bootstrap-'+ctx.repository);
}
function fingerprint(ctx){
  return hash(Buffer.from(JSON.stringify({
    project:ctx.project,repository:ctx.repository,head:ctx.baseline,
    branch:ctx.branch,source:ctx.target,journal:ctx.journalSha256,
    state:ctx.stateSha256
  })));
}
async function acquire(base){
  const lockFile=path.join(base,'bootstrap.lock');
  let h;try{h=await fs.open(lockFile,'wx',0o600);}
  catch(e){if(e.code==='EEXIST')deny('BOOTSTRAP_BUSY_OR_STALE');throw e;}
  await h.writeFile(JSON.stringify({pid:process.pid,utc:new Date().toISOString()})+'\n');
  await h.sync();
  return async()=>{await h.close();await fs.unlink(lockFile);};
}
export function createFleetWorktreeInitializer(config){
  return {
    async plan_scoped_worktree(args){
      const ctx=await snapshot(config,args);
      return {project:ctx.project,repository:ctx.repository,branch:ctx.branch,
        newWorktree:ctx.target,localBaseSha:ctx.baseline,
        journalSha256:ctx.journalSha256,stateSha256:ctx.stateSha256,
        requiresHostWriteApproval:true,readOnly:true};
    },
    async create_scoped_worktree(args){
      const ctx=await snapshot(config,args);
      const base=receiptBase(config,ctx);
      const parent=path.dirname(base);
      await safeDir(path.dirname(parent));
      await fs.mkdir(parent,{recursive:true});
      await safeDir(parent);
      await fs.mkdir(base,{recursive:true});
      await safeDir(base);
      const release=await acquire(base);
      try{
        const intentFile=path.join(base,'intent.json');
        const resultFile=path.join(base,'result.json');
        if(await fs.stat(intentFile).then(()=>true).catch(()=>false))
          deny('BOOTSTRAP_INTENT_ALREADY_EXISTS_NO_REPLAY');
        const fp=fingerprint(ctx);
        const intent={schema:'FLEET_SCOPED_BOOTSTRAP_V1',project:ctx.project,
          repository:ctx.repository,branch:ctx.branch,target:ctx.target,
          baseline:ctx.baseline,journalSha256:ctx.journalSha256,
          stateSha256:ctx.stateSha256,fingerprint:fp,
          action:'local_git_worktree_add_only',remoteEffectsAllowed:false,
          utc:new Date().toISOString()};
        await verifiedCreate(intentFile,intent);
        await fs.mkdir(ctx.folder,{recursive:true});
        await safeDir(ctx.folder);
        await git(ctx.repo,['worktree','add','-b',ctx.branch,ctx.target,ctx.baseline],
          {write:true});
        await safeDir(ctx.target);
        const actual=await git(ctx.target,['rev-parse','HEAD']);
        const branch=await git(ctx.target,['symbolic-ref','--short','HEAD']);
        if(actual!==ctx.baseline||branch!==ctx.branch)
          deny('BOOTSTRAP_GIT_MISMATCH');
        const result={schema:'FLEET_SCOPED_BOOTSTRAP_V1',status:'CREATED_AND_VERIFIED',
          project:ctx.project,repository:ctx.repository,worktree:ctx.target,
          branch,head:actual,fingerprint:fp,canonicalSourceEdited:false,
          remoteEffects:false,utc:new Date().toISOString()};
        await verifiedCreate(resultFile,result);
        return result;
      }finally{await release();}
    }
  };
}
