import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';

const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const origin='http://127.0.0.1:43361',META='io.github.devnoname120/codexify/markdown-chat';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
const row=(page,id)=>page.locator(`.conversation-row[data-chat-id="${id}"]`);
const select=(page,id)=>row(page,id).locator('.conversation').click();
const ack=(page,id)=>page.waitForResponse(response=>new URL(response.url()).pathname===`/api/chats/${id}/read`,{timeout:5000});
async function refresh(page) {
 const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/chats');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await response;
}
async function dot(page,id,visible) {
 await page.waitForFunction(({id,visible})=>{
  const dot=document.querySelector(`[data-chat-id="${id}"] .unread`);return dot&&dot.hidden!==visible;
 },{id,visible});
}
async function reload(page) {
 await page.evaluate(()=>{window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForLoadState('networkidle');await page.reload();
}
async function fixture(browser,legacy=null) {
 const now=Date.now(),chats=[a,b,c].map((id,index)=>({id,title:['First chat','Second chat','Archived chat'][index],workspace:'project',projectId:'project',projectPath:'/fixture/project',lastEntryAtMs:now-index,lastEntryEnd:100,lastIncomingEntryEnd:100,ownerReadThrough:0,lastAgentCallAtMs:null,totalToolCalls:0,pinnedAtMs:null,archivedAtMs:id===c?now:null}));
 const writes=[],errors=[],windows=[];let failure=null,pendingSend=null;
 const listing=()=>structuredClone({chats,serverTimeMs:now,automationEnabled:false});
 async function open(index) {
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();page.setDefaultTimeout(5000);
  await page.addInitScript(({legacy})=>{
   window.testHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden});
   window.setInterval=()=>0;
   const timeout=window.setTimeout.bind(window);window.setTimeout=(callback,delay,...args)=>delay===2000?0:timeout(callback,delay,...args);
   if(legacy&&!sessionStorage.getItem('legacy-seeded')) {localStorage.setItem('owner-chat-seen-v1',JSON.stringify(legacy));sessionStorage.setItem('legacy-seeded','true');}
  },{legacy:index===0?legacy:null});
  page.on('pageerror',error=>errors.push(error.message));
  const windowState={page,context,hold:null};windows.push(windowState);
  await routeOwner(page,origin+'/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(url.pathname==='/api/chats')return route.fulfill({json:listing()});
   const id=url.pathname.split('/')[3],chat=chats.find(chat=>chat.id===id);
   if(!chat)return route.fulfill({json:{enabled:false}});
   if(url.pathname.endsWith('/automation'))return route.fulfill({json:{enabled:false,serverTimeMs:now}});
   if(url.pathname.endsWith('/send')) {
    const body=request.postDataJSON(),end=chat.lastEntryEnd+=100;
    chat.lastEntryAtMs=Date.now();
    if(pendingSend?.id===id){const held=pendingSend;pendingSend=null;held.started();await held.wait;}
    return route.fulfill({json:{_meta:{[META]:{sent:{id:body.request_id,end,created_at_ms:now,tool_call_count:0}}}}});
   }
   if(url.pathname.endsWith('/read')) {
    assert.equal(request.method(),'POST');assert.equal(request.headers().authorization,'Bearer test-token');
    const {through}=request.postDataJSON();writes.push({id,through});assert(through<=chat.lastEntryEnd);
    if(failure===id){failure=null;return route.fulfill({status:503,body:'Temporary read-state failure'});}
    chat.ownerReadThrough=Math.max(chat.ownerReadThrough,through);
    return route.fulfill({json:{ownerReadThrough:chat.ownerReadThrough}});
   }
   const end=chat.lastEntryEnd,unchanged=url.searchParams.get('revision')===String(end);
   const payload={_meta:{[META]:{chat_file:`/fixture/${id}/CHAT.md`,revision:String(end),delivered_through:chat.deliveredThrough||0,read_through:chat.agentReadThrough||0,total_tool_calls:0,server_time_ms:now,messages:unchanged?[]:[{id:`entry-${end}`,role:chat.lastIncomingEntryEnd===end?'agent':'user',markdown:`Response at ${end}`,start:0,end,created_at_ms:now,tool_call_count:0}],has_more:false,unchanged}}};
   if(windowState.hold?.id===id){const held=windowState.hold;windowState.hold=null;held.started();await held.wait;}
   return route.fulfill({json:payload});
  });
  await page.goto(origin+'/#test-token');await row(page,a).waitFor();return page;
 }
 const pages=[await open(0),await open(1)];
 return {pages,chats,writes,errors,fail(id){failure=id;},holdSend(id){
  let started,release;const ready=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  pendingSend={id,started,wait};return {ready,release};
 },hold(page,id){
  let started,release;const ready=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  windows.find(window=>window.page===page).hold={id,started,wait};return {ready,release};
 }};
}

for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]]) {
 test(`${name}: reading a chat syncs across isolated browsers, reloads and archives`,{timeout:25000},async()=>{
  const browser=await engine.launch();
  try {
   const {pages:[first,second],chats,writes,errors}=await fixture(browser);
   await dot(first,a,true);await dot(second,a,true);assert.equal(writes.length,0,'listing alone must not acknowledge messages');
   const read=ack(first,a);await select(first,a);assert.equal((await read).ok(),true);assert.equal(chats[0].ownerReadThrough,100);
   await refresh(second);await dot(second,a,false);await dot(second,b,true);
   const readSecond=ack(second,b);await select(second,b);await readSecond;
   await refresh(first);await dot(first,b,false);
   assert.equal(new URL(first.url()).searchParams.get('chat'),a,'sync does not change selection');
   chats[1].lastIncomingEntryEnd=chats[1].lastEntryEnd=200;await refresh(first);await dot(first,b,true);
   await reload(first);await row(first,a).waitFor();await dot(first,b,true);await dot(first,a,false);
   await first.getByRole('button',{name:'Archived chats',exact:true}).click();await row(first,c).waitFor();
   const readArchive=ack(first,c);await select(first,c);await readArchive;
   await second.getByRole('button',{name:'Archived chats',exact:true}).click();await row(second,c).waitFor();await dot(second,c,false);
   assert.equal(chats[2].archivedAtMs!==null,true,'reading an archive must not restore it');
   assert.equal(await second.evaluate(()=>localStorage.getItem('owner-chat-seen-v1')),null,'new read positions are not stored locally');
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: read acknowledgments use rendered entries, ignore closed or hidden chats, and retry sync failures`,{timeout:25000},async()=>{
  const browser=await engine.launch();
  try {
   const fixtureState=await fixture(browser),{pages:[first,second],chats,writes,errors}=fixtureState;
   const older=fixtureState.hold(first,a);await select(first,a);await older.ready;
   chats[0].lastIncomingEntryEnd=chats[0].lastEntryEnd=200;await refresh(first);
   const read=ack(first,a);older.release();await read;assert.equal(chats[0].ownerReadThrough,100,'a newer sidebar listing cannot acknowledge an unseen message');
   await refresh(second);await dot(second,a,true);
   const bRead=ack(first,b);await select(first,b);await bRead;await dot(first,a,true);
   const late=fixtureState.hold(first,a);await select(first,a);await late.ready;await select(first,b);late.release();
   await first.locator('#chat-host #messages').getByText('Response at 100',{exact:true}).waitFor();
   assert.equal(writes.filter(write=>write.id===a).length,1,'a late response for a closed chat cannot mark it read');
   const hidden=fixtureState.hold(first,a);await select(first,a);await hidden.ready;
   await first.evaluate(()=>{window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});hidden.release();
   await first.locator('#chat-host #messages').getByText('Response at 200',{exact:true}).waitFor();
   assert.equal(chats[0].ownerReadThrough,100,'a response received in a hidden browser is not read');
   fixtureState.fail(a);const failed=ack(first,a);
   await first.evaluate(()=>{window.testHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
   assert.equal((await failed).status(),503);assert.equal(chats[0].ownerReadThrough,100);
   const retried=ack(first,a);await refresh(first);assert.equal((await retried).ok(),true);
   await refresh(second);await dot(second,a,false);assert.equal(chats[0].ownerReadThrough,200);
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: legacy browser read history migrates once without acknowledging newer entries`,{timeout:20000},async()=>{
  const browser=await engine.launch();
  try {
   const {pages:[first,second],chats,writes,errors}=await fixture(browser,{[a]:100,[b]:10000,[c]:'invalid'});
   await first.waitForFunction(()=>localStorage.getItem('owner-chat-seen-v1')===null);
   assert.equal(chats[0].ownerReadThrough,100);assert.equal(chats[1].ownerReadThrough,0);assert.equal(chats[2].ownerReadThrough,0);
   assert.deepEqual(writes,[{id:a,through:100}]);await refresh(second);await dot(second,a,false);await dot(second,b,true);
   chats[0].lastIncomingEntryEnd=chats[0].lastEntryEnd=200;await reload(first);await row(first,a).waitFor();await dot(first,a,true);
   assert.equal(writes.length,1,'a migrated position must not be reimported after reload');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: a delayed own-send response after switching chats never creates an unread dot, including receipt updates`,{timeout:20000},async()=>{
  const browser=await engine.launch();
  try {
   const state=await fixture(browser),{pages:[first,second],chats,errors}=state;
   const read=ack(first,a);await select(first,a);await read;
   const send=state.holdSend(a);await first.locator('#chat-host #draft').fill('My own reply');
   await first.locator('#chat-host').getByRole('button',{name:'Send message',exact:true}).click();await send.ready;
   const bRead=ack(first,b);await select(first,b);await bRead;send.release();
   await refresh(first);await dot(first,a,false);await refresh(second);await dot(second,a,false);
   assert.equal(chats[0].lastEntryEnd,200);assert.equal(chats[0].ownerReadThrough,100,'an outgoing receipt must not acknowledge later incoming messages');
   chats[0].deliveredThrough=200;await refresh(first);await dot(first,a,false);await refresh(second);await dot(second,a,false);
   chats[0].agentReadThrough=200;await refresh(first);await dot(first,a,false);await refresh(second);await dot(second,a,false);
   await reload(first);await row(first,a).waitFor();await dot(first,a,false);
   chats[0].lastIncomingEntryEnd=0;chats[0].ownerReadThrough=0;
   await reload(second);await row(second,a).waitFor();await dot(second,a,false);
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: sending does not clear an unseen incoming message that arrived before the outgoing message`,{timeout:20000},async()=>{
  const browser=await engine.launch();
  try {
   const state=await fixture(browser),{pages:[first,second],chats,errors}=state;
   const read=ack(first,a);await select(first,a);await read;
   chats[0].lastIncomingEntryEnd=chats[0].lastEntryEnd=200;
   const send=state.holdSend(a);await first.locator('#chat-host #draft').fill('Another reply');
   await first.locator('#chat-host').getByRole('button',{name:'Send message',exact:true}).click();await send.ready;
   const bRead=ack(first,b);await select(first,b);await bRead;send.release();
   await refresh(first);await dot(first,a,true);await refresh(second);await dot(second,a,true);
   assert.equal(chats[0].lastEntryEnd,300);assert.equal(chats[0].lastIncomingEntryEnd,200);assert.equal(chats[0].ownerReadThrough,100);
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
}
