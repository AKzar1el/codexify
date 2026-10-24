import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';

const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const origin='http://127.0.0.1:43275',id='e'.repeat(64),META='io.github.devnoname120/codexify/markdown-chat';

for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]) {
 test(`${name}: new chat streams progress, keeps a live timer and preserves retry identity`,{timeout:30000},async()=>{
  const browser=await engine.launch();
  try {
   const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);await page.clock.install();
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{
    const original=window.fetch.bind(window);window.creationRequests=[];
    window.fetch=(input,options={})=>{
     if(new URL(input,location.href).pathname==='/api/chats'&&options.method==='POST') {
      window.creationRequests.push({body:JSON.parse(options.body),headers:options.headers});
      return Promise.resolve(new Response(new ReadableStream({start(controller){window.creationStream=controller;}}),{headers:{'Content-Type':'application/x-ndjson'}}));
     }
     return original(input,options);
    };
   });
   await routeOwner(page,origin+'/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
    if(path==='/api/settings/connector')return route.fulfill({json:{configured:true,connectorName:'Fixture connector'}});
    if(path==='/api/global')return route.fulfill({json:{version:'2.3.12',latest:{updateAvailable:false},settingsAvailable:false,restartAvailable:false}});
    if(path==='/api/analytics/extras')return route.fulfill({status:503});
    if(path==='/api/new-chat')return route.fulfill({json:{catalogRevision:'fixture',models:[{id:'model',label:'Model',efforts:[{id:'max',label:'Pro',available:true}]}]}});
    if(path==='/api/projects')return route.fulfill({json:{createWorktree:true,catalog:{access_root:'/workspace',projects:[{selector:'repo',name:'Existing repo'}]}}});
    if(path==='/api/chats')return route.fulfill({json:{chats:[{id,title:'Created chat',workspace:'repo',lastEntryEnd:0,totalToolCalls:0}],serverTimeMs:Date.now()}});
    if(path.endsWith('/automation'))return route.fulfill({json:{enabled:false,serverTimeMs:Date.now()}});
    return route.fulfill({json:{_meta:{[META]:{chat_file:'/fixture/CHAT.md',messages:[],revision:'0',total_tool_calls:0,server_time_ms:Date.now(),has_more:false}}}});
   });
   await page.goto(origin+'/#test-token');
   await page.getByRole('button',{name:'New chat',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'New chat'}),create=dialog.getByRole('button',{name:'Create chat',exact:true});
   await dialog.getByRole('button',{name:'Existing repo',exact:true}).click();await dialog.locator('#new-chat-model:enabled').waitFor();
   await create.click();
   const progress=dialog.locator('#new-chat-progress'),bar=dialog.locator('#new-chat-progress-bar'),message=dialog.locator('#new-chat-progress-message'),time=dialog.locator('#new-chat-progress-time');
   await progress.waitFor();assert.equal(await bar.getAttribute('value'),null);assert.equal(await create.isDisabled(),true);
   const frame=event=>page.evaluate(event=>window.creationStream.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n')),event);
   await frame({type:'progress',progress:{message:'Cloning repository',detail:'Receiving objects: 42% (42/100)',percent:42}});
   await message.filter({hasText:'Cloning repository'}).waitFor();assert.equal(await bar.getAttribute('value'),'42');
   await page.clock.fastForward(3100);assert.match(await time.textContent(),/Elapsed 3s · Last progress update 3s ago/);
   await frame({type:'heartbeat'});await page.clock.fastForward(2000);assert.match(await time.textContent(),/Last progress update 5s ago/);
   // Split a UTF-8 character across chunks, as a network stream may do.
   await page.evaluate(()=>{
    const bytes=new TextEncoder().encode(JSON.stringify({type:'progress',progress:{message:'Copying file 2 of 5: assets/图形.bin',detail:'400 of 1000 bytes copied',percent:40}})+'\n');
    const split=bytes.indexOf(0xe5)+1;window.creationStream.enqueue(bytes.slice(0,split));window.creationStream.enqueue(bytes.slice(split));
   });
   await message.filter({hasText:'assets/图形.bin'}).waitFor();assert.equal(await bar.getAttribute('value'),'40');
   assert.equal(await progress.evaluate(node=>node.getBoundingClientRect().right<=innerWidth),true);
   await page.screenshot({path:`/tmp/new-chat-progress-${name.toLowerCase()}.png`});
   await frame({type:'progress',progress:{message:'Running project setup',detail:'',percent:null}});
   await message.filter({hasText:'Running project setup'}).waitFor();assert.equal(await bar.getAttribute('value'),null);
   await frame({type:'error',message:'Clone destination already exists'});await page.evaluate(()=>window.creationStream.close());
   await dialog.locator('#new-chat-error').filter({hasText:'Clone destination already exists'}).waitFor();
   assert.equal(await progress.isHidden(),true);assert.equal(await create.isEnabled(),true);
   await create.click();await progress.waitFor();await page.evaluate(()=>window.creationStream.close());
   await dialog.locator('#new-chat-error').filter({hasText:'connection ended before workspace preparation finished'}).waitFor();
   assert.equal(await progress.isHidden(),true);
   await create.click();await progress.waitFor();await frame({type:'result',result:{id,queued:true}});await page.evaluate(()=>window.creationStream.close());
   await dialog.waitFor({state:'hidden'});
   const requests=await page.evaluate(()=>window.creationRequests);
   assert.equal(requests.length,3);assert.equal(new Set(requests.map(request=>request.body.requestId)).size,1);
   assert(requests.every(request=>request.headers.Accept==='application/x-ndjson'&&request.headers.Authorization==='Bearer test-token'));
   assert.deepEqual(errors,[]);
  } finally {await browser.close();}
 });
}
