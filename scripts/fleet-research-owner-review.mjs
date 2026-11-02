// Intentionally NOT advertised as an MCP tool: only an interactive owner can
// approve/defer/close tasks; scheduled workers remain proposal-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import {createHash} from 'node:crypto';
import {ownerReviewResearchTask} from './fleet-research-inbox.mjs';

async function main(){
  const [id,status]=process.argv.slice(2);
  if(!process.stdin.isTTY||!process.stdout.isTTY)
    throw new Error('OWNER_INTERACTIVE_TERMINAL_REQUIRED');
  if(typeof id!=='string'||!/^[a-f0-9]{12}$/.test(id)||
     !['APPROVED','DEFERRED','DONE','REJECTED'].includes(status))
    throw new Error('Usage: node fleet-research-owner-review.mjs TASK_ID APPROVED|DEFERRED|DONE|REJECTED');
  const configFile=process.env.REVENUE_SHOT_PROJECTS_FILE;
  if(typeof configFile!=='string'||!path.isAbsolute(configFile))
    throw new Error('Set REVENUE_SHOT_PROJECTS_FILE to the approved private sidecar config');
  const config=JSON.parse(await fs.readFile(configFile,'utf8'));
  if(config.enableResearchInbox!==true||typeof config.researchInboxRoot!=='string')
    throw new Error('Research inbox not operator enabled');
  const raw=await fs.readFile(path.join(config.researchInboxRoot,'tasks.json'));
  const state=JSON.parse(raw.toString('utf8'));
  const item=state.items?.find(x=>x.id===id);
  if(!item)throw new Error('Task ID not found');
  process.stdout.write('\nOWNER REVIEW (this is NOT task implementation)\n');
  process.stdout.write('Task: '+id+' | '+item.project+' | '+item.title+'\n');
  process.stdout.write('Change: '+item.status+' -> '+status+'\n');
  const required='REVIEW '+id+' '+status;
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try{
    const response=(await rl.question('Type "'+required+'" to continue: ')).trim();
    if(response!==required)throw new Error('OWNER_REVIEW_DECLINED');
  }finally{rl.close();}
  const sha=createHash('sha256').update(raw).digest('hex');
  const outcome=await ownerReviewResearchTask(config,{
    id,status,expected_state_sha256:sha});
  process.stdout.write('Reviewed: '+JSON.stringify(outcome)+'\n');
}
main().catch(error=>{
  process.stderr.write(String(error.message||error)+'\n');
  process.exitCode=1;
});
