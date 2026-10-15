import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {ownerHtml} from './owner-chat-source.mjs';

const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const META='io.github.devnoname120/codexify/markdown-chat';
const origin='http://127.0.0.1:43261';
const now=Date.parse('2026-10-15T12:00:00+02:00');
const day=24*60*60*1000;

async function fixture(browser) {
 const page=await browser.newPage({viewport:{width:1280,height:960},timezoneId:'Europe/Zurich'});
 await page.clock.setFixedTime(new Date(now));page.setDefaultTimeout(6000);
 await page.addInitScript(()=>{
  window.testHidden=false;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden});
 });
 const errors=[],operations=[];let shift=0,held=false,release;
 let gate=Promise.resolve();
 const chats=[0,1,3,8,20,50,0,2].map((days,i)=>({
  id:String(i+1).repeat(64),title:`Conversation ${i+1}`,customTitle:null,
  workspace:i===5?'f'.repeat(64):'packages',isScratch:i===5,
  projectPath:i===5?'/private/scratch/'+ 'f'.repeat(64):'/Volumes/data/dev/projects/packages',projectId:`project-${i}`,
  lastEntryAtMs:now-days*day,lastEntryEnd:200,totalToolCalls:32,lastAgentCallAtMs:now-1000,
  pinnedAtMs:i===6?now:null,archivedAtMs:i===7?now:null,
 }));
 const messages=[
  {id:'before',role:'agent',markdown:'Before completion',start:0,end:100,tool_call_count:1,created_at_ms:now-60000},
  {id:'goal-completed-1-2',role:'goal',markdown:'Goal completed: Review and analyze this PR',start:100,end:100,tool_call_count:11,created_at_ms:now-30000},
  {id:'after',role:'agent',markdown:'After completion',start:100,end:200,tool_call_count:32,created_at_ms:now-1000},
 ];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route(origin+'/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
  if(held&&(url.pathname==='/api/chats'||/^\/api\/chats\/[0-9a-f]+$/.test(url.pathname)))await gate;
  if(url.pathname==='/api/global')return route.fulfill({json:{version:'1.7.0',plan:{kind:'pro',label:'Pro 20x'},latest:{updateAvailable:false},settingsAvailable:true,restartAvailable:false}});
  if(url.pathname==='/api/settings')return route.fulfill({json:{revision:'one',document:{},defaults:{},raw:'{}',path:'/fixture/config.json',restartRequired:false}});
  if(url.pathname==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(url.pathname==='/api/projects')return route.fulfill({json:{catalog:{projects:[],total:0},createWorktree:false}});
  if(url.pathname==='/api/new-chat')return route.fulfill({json:{models:[{id:'gpt-6-astra',label:'GPT-6 Astra',efforts:[{id:'max',label:'Pro',available:true}]}],catalogRevision:'one',multiProject:true,createWorktree:false}});
  if(url.pathname==='/api/chats')return route.fulfill({json:{chats,matchedChatIds:chats.map(chat=>chat.id),serverTimeMs:now+shift}});
  const id=url.pathname.split('/')[3],chat=chats.find(chat=>chat.id===id);assert(chat,'known chat request: '+url.pathname);
  if(url.pathname.endsWith('/title')){
   const body=request.postDataJSON();operations.push({kind:'title',...body});chat.title=body.title||'Latest message';chat.customTitle=body.title||null;
   return route.fulfill({json:{title:chat.title,customTitle:chat.customTitle}});
  }
  if(url.pathname.endsWith('/project')){
   const body=request.postDataJSON();operations.push({kind:'project',...body});assert.equal(body.expectedPath,chat.projectPath);
   chat.projectPath=body.path;chat.workspace='changed';chat.isScratch=false;chat.projectId='changed';
   return route.fulfill({json:{projectPath:chat.projectPath,workspace:chat.workspace,isScratch:false,projectId:'changed'}});
  }
  if(url.pathname.endsWith('/automation'))return route.fulfill({json:{enabled:true,pairing:{status:'verified'},selection:{model:'gpt-6-astra',effort:'max'},action:{status:'idle'},goal:null,companion:{authenticated:true,status:'idle'},presence:{lastAgentCallAtMs:now+shift-1000},serverTimeMs:now+shift}});
  return route.fulfill({json:{_meta:{[META]:{chat_file:'/fixture/'+id+'/CHAT.md',revision:'200-'+shift,read_through:200,delivered_through:200,messages,total_tool_calls:32,last_agent_call_at_ms:now+shift-1000,server_time_ms:now+shift,has_more:false,unchanged:false}}}});
 });
 await page.goto(origin+'/?chat='+chats[0].id+'#test-token');await page.locator('.conversation-row').first().waitFor();
 return {page,chats,errors,operations,hold(){held=true;gate=new Promise(resolve=>release=resolve);},release(){held=false;release?.();},advance(ms){shift+=ms;for(const chat of chats)chat.lastAgentCallAtMs=now+shift-1000;}};
}

for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]) {
 test(`${name}: goal timeline, project path editing, inline rename and backdrop dismissal`,{timeout:45000},async()=>{
  const browser=await engine.launch();
  try {
   const {page,chats,errors,operations}=await fixture(browser),host=page.locator('#chat-host');
   const capture=async label=>{if(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_UI_POLISH_SCREENSHOTS}/${name.toLowerCase()}-${label}.png`});}};
   await host.locator('.goal-completed-event').waitFor();
   assert.deepEqual(await host.locator('#messages > .tool-call-marker, #messages > .goal-completed-event').allTextContents(),['10 tool calls','Goal completed: Review and analyze this PR'+await host.locator('.goal-completed-event .receipt').textContent(),'21 tool calls']);
   assert.equal(await host.locator('.goal-completed-event').count(),1);
   assert.equal(await host.locator('.project-path').textContent(),chats[0].projectPath);
   await host.locator('#chat-title').click();
   const input=host.getByRole('textbox',{name:'Chat name',exact:true});await input.fill('Renamed inline');await capture('inline-name');await input.press('Enter');
   await host.getByRole('button',{name:'Rename conversation',exact:true}).filter({hasText:'Renamed inline'}).waitFor();
   assert.equal(operations.filter(item=>item.kind==='title').length,1);
   await host.locator('#chat-title').click();await input.fill('Discard this');await input.press('Escape');
   assert.equal(await host.locator('#chat-title').textContent(),'Renamed inline');
   await host.getByRole('button',{name:'Connection settings',exact:true}).click();
   const path=host.getByRole('textbox',{name:'Full project path',exact:true});assert.equal(await path.inputValue(),chats[0].projectPath);
   await capture('conversation-settings');
   await path.fill('/Volumes/data/dev/projects/changed');await host.getByRole('button',{name:'Save project path',exact:true}).click();
   await host.locator('.project-path').filter({hasText:'/Volumes/data/dev/projects/changed'}).waitFor();
   assert.equal(operations.filter(item=>item.kind==='project').length,1);
   await page.mouse.click(2,2);await host.locator('#automation-settings').waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Codexify settings',exact:true}).click();await page.locator('#settings-dialog[open]').waitFor();
   await page.mouse.click(2,2);await page.locator('#settings-dialog').waitFor({state:'hidden'});
   await page.getByRole('button',{name:'New chat',exact:true}).click();await page.locator('#new-chat-dialog[open]').waitFor();
   await page.mouse.click(2,2);await page.locator('#new-chat-dialog').waitFor({state:'hidden'});
   await page.setViewportSize({width:390,height:960});
   await host.locator('#chat-title').click();await capture('inline-name-mobile');
   assert.equal(await page.locator('body').evaluate(body=>body.scrollWidth>innerWidth),false,'inline naming fits a narrow viewport');
   await input.press('Escape');await page.setViewportSize({width:1280,height:960});
   if(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_UI_POLISH_SCREENSHOTS}/${name.toLowerCase()}-timeline.png`});}
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: recent groups are disjoint and scratch and archived labels stay readable`,{timeout:30000},async()=>{
  const browser=await engine.launch();
  try {
   const {page,chats,errors}=await fixture(browser);
   await page.getByRole('button',{name:'Recent',exact:true}).click();
   if(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_UI_POLISH_SCREENSHOTS}/${name.toLowerCase()}-recent.png`});}
   assert.deepEqual(await page.locator('.recent-heading').allTextContents(),['Pinned','Today','Yesterday','This week','Last week','Last month','Older']);
   const ids=await page.locator('.conversation-row').evaluateAll(rows=>rows.map(row=>row.dataset.chatId));assert.equal(new Set(ids).size,ids.length);
   const scratch=page.locator(`.conversation-row[data-chat-id="${chats[5].id}"]`);
   assert((await scratch.textContent()).includes('Scratch conversation'));assert(!(await scratch.textContent()).includes('f'.repeat(32)));
   await scratch.locator('.conversation').click();await page.locator('#chat-host #chat-title').filter({hasText:chats[5].title}).waitFor();
   assert((await page.locator('#chat-host #chat-subtitle').textContent()).includes('Scratch conversation'));
   await page.getByRole('button',{name:'Archived chats',exact:true}).click();
   const fill=await page.locator('.restore-action .archive-body').evaluate(path=>getComputedStyle(path).fill);assert.notEqual(fill,'none');
   for(const width of [1280,390]){
    await page.setViewportSize({width,height:960});
    assert.equal(await page.locator('body').evaluate(body=>body.scrollWidth>innerWidth),false,'no horizontal overflow');
    if(process.env.CODEXIFY_UI_POLISH_SCREENSHOTS)await page.screenshot({path:`${process.env.CODEXIFY_UI_POLISH_SCREENSHOTS}/${name.toLowerCase()}-archived-${width}.png`});
   }
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: returning from a hidden tab keeps previous presence until fresh responses arrive`,{timeout:30000},async()=>{
  const browser=await engine.launch();
  try {
   const f=await fixture(browser),{page,chats,errors}=f;
   const sidebar=page.locator(`.conversation-row[data-chat-id="${chats[0].id}"] .presence`),header=page.locator('#chat-host #presence');
   await sidebar.locator('.presence-spinner').waitFor();await page.waitForFunction(()=>document.querySelector('#chat-host .chat-shell').shadowRoot.querySelector('#presence').dataset.state==='online');
   f.hold();await page.evaluate(()=>{window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});
   f.advance(10*60*1000);await page.clock.setFixedTime(new Date(now+10*60*1000));
   await page.evaluate(()=>{window.testHidden=false;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));});
   const observations=await page.evaluate(async()=>{
    const result=[];for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);result.push({sidebar:document.querySelector('.conversation-row[data-chat-id="'+ '1'.repeat(64)+'"] .presence').className,header:document.querySelector('#chat-host .chat-shell').shadowRoot.querySelector('#presence').dataset.state});}return result;
   });
   assert(observations.every(value=>value.sidebar.includes('online')&&value.header==='online'),'no temporary away/offline state while refreshing');
   f.release();await page.waitForFunction(()=>document.querySelector('#chat-host .chat-shell').shadowRoot.querySelector('#presence').dataset.state==='online');
   assert.equal(await header.getAttribute('data-state'),'online');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
}
