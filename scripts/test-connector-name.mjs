import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {ownerHtml} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const origin='http://127.0.0.1:43278',id='c'.repeat(64),meta='io.github.devnoname120/codexify/markdown-chat';
async function fixture(engine,{goal=null,mobile=false}={}) {
 const browser=await engine.launch();const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900}});page.setDefaultTimeout(6000);
 const errors=[],commands=[],names=[];let configured=null,preparations=0,rejectSave=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin+'/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname,now=Date.now();
  if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
  if(path.startsWith('/api/'))assert.equal(r.headers().authorization,'Bearer fixture-token');
  if(path==='/api/global')return route.fulfill({json:{version:'2.1.0',settingsAvailable:true,latest:{updateAvailable:false}}});
  if(path==='/api/settings/connector'){
   if(r.method()==='GET')return route.fulfill({json:{configured:configured!==null,connectorName:configured,canSave:true}});
   const name=r.postDataJSON().connectorName;names.push(name);
   if(rejectSave)return route.fulfill({status:400,body:'Could not save configuration.'});
   configured=name;return route.fulfill({json:{configured:true,connectorName:configured}});
  }
  if(path==='/api/chats')return route.fulfill({json:{chats:[{id,title:'Connector test',workspace:'fixture',lastEntryEnd:0,lastAgentCallAtMs:now,totalToolCalls:1,goalStatus:goal?.status}],serverTimeMs:now}});
  if(path===`/api/chats/${id}/automation`)return route.fulfill({json:{enabled:true,goal,pairing:{status:'verified'},action:{status:'idle'},selection:{model:'gpt-6-sol',effort:'high'},companion:{authenticated:true,status:'idle'},catalog:{models:[{id:'gpt-6-sol',label:'GPT-6 Sol',efforts:[{id:'high',label:'High',available:true}]}]},presence:{lastAgentCallAtMs:now},serverTimeMs:now}});
  if(path===`/api/chats/${id}/send`){assert(configured,'a goal cannot be sent before connector setup');const body=r.postDataJSON();commands.push(body.message);if(body.message==='/goal run')goal={...goal,status:'active'};else if(body.message.startsWith('/goal set '))goal={revision:1,status:'configured',markdown:body.message.slice(10),turnCount:0,elapsedActiveMs:0};return route.fulfill({json:{_meta:{[meta]:{goal}}}});}
  if(path==='/api/projects')return route.fulfill({json:{catalog:{projects:[],total:0},createWorktree:false}});
  if(path==='/api/new-chat'){if(!configured)return route.fulfill({status:428,body:'Configure the exact connector name.'});preparations++;return route.fulfill({json:{catalogRevision:'fixture',models:[{id:'gpt-6-sol',label:'GPT-6 Sol',efforts:[{id:'high',label:'High',available:true}]}],createWorktree:false}});}
  if(path===`/api/chats/${id}`)return route.fulfill({json:{_meta:{[meta]:{chat_file:'/fixture/CHAT.md',revision:'0',messages:[],has_more:false,delivered_through:0,read_through:0,last_agent_call_at_ms:now,total_tool_calls:1,server_time_ms:now}}}});
  return route.fulfill({json:{}});
 });
 await page.goto(origin+'/#fixture-token');await page.locator('.conversation').filter({hasText:'Connector test'}).waitFor();
 return {browser,page,errors,commands,names,clearName(){configured=null;},get preparations(){return preparations;},set rejectSave(v){rejectSave=v;}};
}
for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]) {
 test(`${name}: new conversation requires the exact saved name and resumes without a restart`,async()=>{
  const f=await fixture(engine,{mobile:true});try{
   await f.page.getByRole('button',{name:'New chat',exact:true}).click();const dialog=f.page.getByRole('dialog',{name:'Configure your ChatGPT connector'});await dialog.waitFor();assert.equal(f.preparations,0);assert.equal(await dialog.getByLabel('Exact connector name').inputValue(),'');
   const box=await dialog.boundingBox();assert(box.width<=390&&box.x>=0);assert.equal(await dialog.getByLabel('Exact connector name').evaluate(n=>getComputedStyle(n).fontSize),'16px');
   if(process.env.CONNECTOR_SCREENSHOTS){mkdirSync(process.env.CONNECTOR_SCREENSHOTS,{recursive:true});await f.page.screenshot({path:process.env.CONNECTOR_SCREENSHOTS+'/'+name+'-connector-name.png'});}
   await dialog.getByLabel('Exact connector name').fill('My exact connector [Pro]');await dialog.getByRole('button',{name:'Save and continue'}).click();await f.page.locator('#new-chat-model:enabled').waitFor();assert.equal(f.preparations,1);assert.deepEqual(f.names,['My exact connector [Pro]']);
   await f.page.reload();await f.page.getByRole('button',{name:'New chat',exact:true}).click();await f.page.locator('#new-chat-model:enabled').waitFor();assert.equal(f.preparations,2);assert.equal(await dialog.isVisible(),false);assert.deepEqual(f.names,['My exact connector [Pro]']);assert.deepEqual(f.errors,[]);
  }finally{await f.browser.close();}
 });
 test(`${name}: clearing a previously saved name is rechecked before browser work`,async()=>{
  const f=await fixture(engine);try{
   await f.page.getByRole('button',{name:'New chat',exact:true}).click();const d=f.page.getByRole('dialog',{name:'Configure your ChatGPT connector'});await d.getByLabel('Exact connector name').fill('Original connector');await d.getByRole('button',{name:'Save and continue'}).click();await f.page.locator('#new-chat-model:enabled').waitFor();await f.page.locator('#new-chat-close').click();
   f.clearName();await f.page.getByRole('button',{name:'New chat',exact:true}).click();await d.waitFor();assert.equal(f.preparations,1);await d.getByLabel('Exact connector name').fill('Replacement connector');await d.getByRole('button',{name:'Save and continue'}).click();await f.page.locator('#new-chat-model:enabled').waitFor();assert.equal(f.preparations,2);assert.deepEqual(f.names,['Original connector','Replacement connector']);assert.deepEqual(f.errors,[]);
  }finally{await f.browser.close();}
 });
 test(`${name}: cancel, Escape and backdrop leave conversation creation untouched`,async()=>{
  const f=await fixture(engine);try{
   for(const close of ['cancel','escape','backdrop']){
    await f.page.getByRole('button',{name:'New chat',exact:true}).click();const d=f.page.getByRole('dialog',{name:'Configure your ChatGPT connector'});await d.waitFor();
    if(close==='cancel')await d.getByRole('button',{name:'Cancel',exact:true}).click();else if(close==='escape')await f.page.keyboard.press('Escape');else await f.page.mouse.click(2,2);
    await d.waitFor({state:'hidden'});assert.equal(f.preparations,0);assert.deepEqual(f.names,[]);
   }
   assert.deepEqual(f.errors,[]);
  }finally{await f.browser.close();}
 });
 test(`${name}: a failed save keeps the prompt and prevents the pending action`,async()=>{
  const f=await fixture(engine);try{
   f.rejectSave=true;await f.page.getByRole('button',{name:'New chat',exact:true}).click();const d=f.page.getByRole('dialog',{name:'Configure your ChatGPT connector'});await d.getByLabel('Exact connector name').fill('Exact name');await d.getByRole('button',{name:'Save and continue'}).click();await d.getByText('Could not save configuration.').waitFor();assert.equal(f.preparations,0);assert.equal(await d.getByLabel('Exact connector name').inputValue(),'Exact name');
   f.rejectSave=false;await d.getByRole('button',{name:'Save and continue'}).click();await f.page.locator('#new-chat-model:enabled').waitFor();assert.equal(f.preparations,1);assert.deepEqual(f.errors,[]);
  }finally{await f.browser.close();}
 });
 test(`${name}: starting a configured goal prompts and sends it exactly once after saving`,async()=>{
  const f=await fixture(engine,{goal:{revision:1,status:'configured',markdown:'Finish this task',elapsedActiveMs:0,turnCount:0}});try{
   await f.page.locator('.conversation').filter({hasText:'Connector test'}).click();await f.page.locator('#automation-toggle-goal').waitFor();await f.page.locator('#automation-toggle-goal').click();const d=f.page.getByRole('dialog',{name:'Configure your ChatGPT connector'});await d.waitFor();assert.deepEqual(f.commands,[]);await d.getByLabel('Exact connector name').fill('Goals connector');await d.getByRole('button',{name:'Save and continue'}).click();await f.page.locator('#goal-caption').filter({hasText:'Pursuing goal'}).waitFor();assert.deepEqual(f.commands,['/goal run']);assert.deepEqual(f.names,['Goals connector']);assert.deepEqual(f.errors,[]);
  }finally{await f.browser.close();}
 });
}
