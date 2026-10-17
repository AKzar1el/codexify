import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const META='io.github.devnoname120/codexify/markdown-chat';
const id='a'.repeat(64),base='http://127.0.0.1:43314';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<100;i++){if(await predicate())return;await pause(40);}assert.fail('Expected state did not arrive');}
async function fixture(browser,{platform='MacIntel',width=1280,mode='steer',queued=[]}={}){
 const context=await browser.newContext({viewport:{width,height:900}});
 await context.addInitScript(platform=>Object.defineProperty(navigator,'platform',{value:platform}),platform);
 const page=await context.newPage();page.setDefaultTimeout(6000);
 const errors=[],calls=[],messages=[{id:'agent-progress',role:'agent',markdown:'The current request is still running.',start:0,end:100,created_at_ms:Date.now(),tool_call_count:1}];
 page.on('pageerror',error=>errors.push(error.message));
 const backend={queue:queued.map((markdown,i)=>({id:`queue-${i}`,revision:1,markdown,attachment_ids:[],attachments:[],created_at_ms:Date.now()+i})),mode,revision:1,settingsRevision:1,end:100,failAfterQueue:false,pollDelay:null};
 const defaults=JSON.parse(readFileSync(new URL('../codexify.config.example.json',import.meta.url)));
 const document={workDir:'/fixture',agentChat:{enabled:true,defaultMessageMode:mode},codexMcp:{enabled:false}};
 const settings=()=>({path:'/fixture/settings.json',defaults,document,raw:JSON.stringify(document),revision:String(backend.settingsRevision),restartRequired:false});
 const state=()=>({_meta:{[META]:{chat_file:'/fixture/chats/CHAT.md',workspace_path:'/fixture',revision:String(backend.revision),messages:[...messages],delivered_through:0,read_through:0,total_tool_calls:1,last_agent_call_at_ms:Date.now(),server_time_ms:Date.now(),has_more:false,unchanged:false,queued_messages:structuredClone(backend.queue),default_message_mode:backend.mode}}});
 const append=(entry)=>{const msg={...entry,role:'user',start:backend.end,end:backend.end+100,tool_call_count:1};backend.end=msg.end;messages.push(msg);backend.revision++;return msg;};
 const receipt=(entry)=>({id:entry.id,end:entry.end,created_at_ms:entry.created_at_ms,tool_call_count:entry.tool_call_count});
 await routeOwner(page, `${base}/**`,async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
  assert.equal(request.headers().authorization,'Bearer queue-test-token');
  if(path==='/api/global')return route.fulfill({json:{version:'2.0.0',plan:null,settingsAvailable:true,restartAvailable:true,latest:{updateAvailable:false}}});
  if(path==='/api/settings'&&request.method()==='GET')return route.fulfill({json:settings()});
  if(path==='/api/settings'){
   const body=request.postDataJSON();calls.push({path,body});
   for(const[key,value]of Object.entries(body.changes)){assert.equal(key,'agentChat.defaultMessageMode');document.agentChat.defaultMessageMode=value;backend.mode=value;}
   backend.settingsRevision++;return route.fulfill({json:settings()});
  }
  if(path==='/api/chats')return route.fulfill({json:{chats:[{id,title:'Queued messages',workspace:'fixture',workspacePath:'/fixture',lastEntryAtMs:Date.now(),lastEntryEnd:backend.end,lastAgentCallAtMs:Date.now(),totalToolCalls:1}],serverTimeMs:Date.now()}});
  if(path.endsWith('/automation'))return route.fulfill({json:{enabled:false,goal:null,pairing:{status:'unpaired'},action:{status:'idle'},selection:{},catalog:{models:[]},companion:{authenticated:false,status:'idle'},presence:{lastAgentCallAtMs:Date.now()},serverTimeMs:Date.now()}});
  if(path===`/api/chats/${id}/send`){
   const body=request.postDataJSON();calls.push({path,body});
   if(body.message_mode==='queue'){
    let entry=backend.queue.find(e=>e.id===body.request_id);
    if(!entry){entry={id:body.request_id,revision:1,markdown:body.message,attachment_ids:[],attachments:[],created_at_ms:Date.now()};backend.queue.push(entry);}
    if(backend.failAfterQueue){backend.failAfterQueue=false;return route.fulfill({status:503,body:'Connection lost after private save'});}
    return route.fulfill({json:{_meta:{[META]:{queue_receipt:{queued:entry,sent:null,discarded:false},queued_messages:backend.queue}}}});
   }
   const sent=append({id:body.request_id,markdown:body.message,created_at_ms:Date.now()});return route.fulfill({json:{_meta:{[META]:{sent:receipt(sent)}}}});
  }
  if(path===`/api/chats/${id}/queue`){
   const body=request.postDataJSON();calls.push({path,body});const entry=backend.queue.find(e=>e.id===body.id);
   if(!entry||entry.revision!==body.revision)return route.fulfill({status:409,body:'This queued message changed; refresh before trying again'});
   let sent=null;if(body.action==='edit'){entry.markdown=body.message;entry.revision++;}else{backend.queue=backend.queue.filter(e=>e.id!==entry.id);if(body.action==='steer')sent=receipt(append(entry));}
   return route.fulfill({json:{_meta:{[META]:{queue_receipt:{queued:body.action==='edit'?entry:null,sent,discarded:body.action==='trash'},queued_messages:backend.queue}}}});
  }
  if(path===`/api/chats/${id}`){const payload=state();if(backend.pollDelay){const barrier=backend.pollDelay;backend.pollDelay=null;barrier.captured();await barrier.promise;}return route.fulfill({json:payload});}
  return route.fulfill({status:404,body:`Unhandled ${path}`});
 });
 await page.goto(`${base}/?chat=${id}#queue-test-token`);
 const host=page.locator('#chat-host');await host.locator('#draft:enabled').waitFor();await host.locator('#messages .message').waitFor();
 return{page,context,host,backend,calls,errors,messages};
}
for(const[engineName,engine]of[['Chromium',chromium],['WebKit',webkit]]){
 test(`${engineName}: per-message keyboard override, defaults and private queue controls`,{timeout:60000},async()=>{
  const browser=await engine.launch();
  try{
   for(const platform of ['MacIntel','Win32']){
    const f=await fixture(browser,{platform});const{page,host,backend,calls,errors}=f;
    const input=host.locator('#draft'),modifier=platform==='MacIntel'?'Meta':'Control';
    const send=async(text,key='Enter')=>{const before=calls.length;await input.fill(text);await input.press(key);await until(()=>calls.length>before);await until(()=>input.isEnabled());await until(()=>host.locator('#send').isEnabled());};
    await send('Steering by default');await until(()=>f.messages.length===2);
    assert.equal(calls.at(-1).body.message_mode,'steer');
    await send('First private queued request',`${modifier}+Enter`);await host.locator('.queued-message').waitFor();
    assert.equal(calls.at(-1).body.message_mode,'queue');assert.equal(f.messages.length,2);assert.equal(backend.mode,'steer');
    await send('Second private queued request',`${modifier}+Enter`);await until(()=>backend.queue.length===2);
    assert.equal(await host.locator('#messages').getByText('First private queued request',{exact:true}).count(),0);
    assert.equal(await host.locator('.queued-message').count(),2);
    assert.equal(await host.getByRole('button',{name:'Steer queued message',exact:true}).count(),2);
    assert.equal(await host.getByRole('button',{name:'Delete queued message',exact:true}).count(),2);
    assert.equal(await host.getByRole('button',{name:'Edit queued message',exact:true}).count(),2);
    const row=host.locator('.queued-message').first();await row.getByRole('button',{name:'Edit queued message',exact:true}).click();
    await row.getByRole('textbox',{name:'Edit queued message text'}).fill('Privately edited first request');
    await pause(1700);assert.equal(await row.getByRole('textbox',{name:'Edit queued message text'}).inputValue(),'Privately edited first request','polling preserves unsaved edits');assert(await row.getByRole('textbox').evaluate(e=>e.getRootNode().activeElement===e),'polling preserves editing focus');
    await row.getByRole('button',{name:'Save queued message',exact:true}).click();await until(()=>backend.queue[0]?.revision===2);
    await until(()=>row.getByRole('textbox').isHidden());assert.equal(backend.queue[0].markdown,'Privately edited first request');
    assert.equal(await host.locator('#messages').getByText('Privately edited first request',{exact:true}).count(),0);
    await host.locator('.queued-message').last().getByRole('button',{name:'Steer queued message',exact:true}).click();await until(()=>backend.queue.length===1);
    assert.equal(backend.queue[0].markdown,'Privately edited first request');await until(()=>f.messages.length===3);
    await host.locator('.queued-message').first().getByRole('button',{name:'Delete queued message',exact:true}).click();await host.locator('#queued-messages').waitFor({state:'hidden'});
    assert.equal(f.messages.length,3);
    await page.getByRole('button',{name:'Codexify settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Codexify settings'});
    await settings.getByRole('button',{name:'Chats & goals',exact:true}).click();await settings.getByLabel('agentChat.defaultMessageMode',{exact:true}).selectOption('queue');
    await settings.getByText('All changes saved.',{exact:true}).waitFor();await settings.getByRole('button',{name:'Close settings'}).click();
    await send('Default is now queue');await until(()=>backend.queue.length===1);assert.equal(calls.at(-1).body.message_mode,'queue');
    await send('Override to steer',`${modifier}+Enter`);await until(()=>f.messages.length===4);assert.equal(calls.at(-1).body.message_mode,'steer');assert.equal(backend.queue.length,1);
    await send('Still queue by default');await until(()=>backend.queue.length===2);assert.equal(calls.at(-1).body.message_mode,'queue');
    await input.fill('A multiline draft');await input.press('Shift+Enter');await input.type('Second line');assert.equal(await input.inputValue(),'A multiline draft\nSecond line');
    assert.deepEqual(errors,[]);await f.context.close();
   }
  }finally{await browser.close();}
 });
 test(`${engineName}: queue edits survive conflicts and lost responses reconcile without duplicates`,{timeout:30000},async()=>{
  const browser=await engine.launch();try{
   const f=await fixture(browser,{queued:['First queued request','Second queued request']});const{host,backend,errors,page}=f;
   const row=host.locator('.queued-message').first();await row.getByRole('button',{name:'Edit queued message',exact:true}).click();
   await row.getByRole('textbox').fill('Local edit');backend.queue[0].revision++;backend.queue[0].markdown='Concurrent edit';
   await row.getByRole('button',{name:'Save queued message',exact:true}).click();await host.getByText('This queued message changed; refresh before trying again',{exact:true}).waitFor();
   assert.equal(await row.getByRole('textbox').inputValue(),'Local edit');assert.equal(backend.queue[0].markdown,'Concurrent edit');
   await row.getByRole('button',{name:'Cancel editing queued message',exact:true}).click();
   backend.failAfterQueue=true;await host.locator('#draft').fill('Saved despite a lost response');await host.locator('#draft').press('Meta+Enter');
   await until(()=>backend.queue.length===3);await until(async()=>await host.locator('.queued-message').count()===3);
   await pause(1700);assert.equal(backend.queue.filter(e=>e.markdown==='Saved despite a lost response').length,1);await host.getByText('Message queued privately. It will be sent after the current request is complete.',{exact:true}).waitFor();
   assert.equal(await host.locator('#messages').getByText('Saved despite a lost response',{exact:true}).count(),0);
   assert.deepEqual(errors,[]);await f.context.close();
  }finally{await browser.close();}
 });
 test(`${engineName}: compact queue layout works on mobile, desktop and dark mode`,{timeout:30000},async()=>{
  const browser=await engine.launch();try{
   const f=await fixture(browser,{width:390,queued:['Please investigate a particularly long request which must truncate without squeezing the controls','Keep this separate for the next turn']});
   const{page,host,errors}=f;
   f.backend.queue[0].attachments=[{id:'f'.repeat(32),originalName:'Queued notes.txt',mimeType:'text/plain',size:1200}];
   await host.locator('.queued-attachments .attachment-card').waitFor();
   const visual=host.locator('.queued-attachments .attachment-visual'),glyph=visual.locator('svg');
   const visualBox=await visual.boundingBox(),glyphBox=await glyph.boundingBox();assert(glyphBox.width<=visualBox.width&&glyphBox.height<=visualBox.height,'queued file icons fit without clipping');
   for(const colorScheme of ['light','dark'])for(const width of [390,1280]){
    await page.emulateMedia({colorScheme});await page.setViewportSize({width,height:900});
    const region=host.locator('#queued-messages');await region.waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await region.evaluate(e=>e.scrollWidth>e.clientWidth),false);
    for(const button of await region.getByRole('button').all()){if(!await button.isVisible())continue;const box=await button.boundingBox();assert(box.x>=0&&box.x+box.width<=width);}
    assert.equal(await region.getByRole('button').filter({hasText:'…'}).count(),0);
    if(process.env.QUEUE_SCREENSHOTS){mkdirSync(process.env.QUEUE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.QUEUE_SCREENSHOTS}/${engineName.toLowerCase()}-${width}-${colorScheme}.png`});}
   }
   await host.locator('.queued-message').first().getByRole('button',{name:'Edit queued message',exact:true}).click();await page.setViewportSize({width:390,height:900});assert.equal(await host.locator('#queued-messages').evaluate(e=>e.scrollWidth>e.clientWidth),false);
   assert.deepEqual(errors,[]);await f.context.close();
  }finally{await browser.close();}
 });
}
