import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const origin='http://127.0.0.1:43357',META='io.github.devnoname120/codexify/markdown-chat';
for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: sidebar recovery spins red through backoff and execution, then recovers or stops on terminal failure`,{timeout:30000},async()=>{
 const browser=await engine.launch(),page=await browser.newPage({viewport:{width:1280,height:820}});page.setDefaultTimeout(5000);
 try{
  const now=Date.now(),errors=[],writes=[],chats=[
   {id:'a'.repeat(64),title:'Healthy conversation',goalStatus:null,lastAgentCallAtMs:now},
   {id:'b'.repeat(64),title:'Retrying conversation',goalStatus:null,lastAgentCallAtMs:null,automationError:'Browser operation timed out',automationRetrying:true},
   {id:'c'.repeat(64),title:'Retrying objective',goalStatus:'active',lastAgentCallAtMs:null,automationError:'Browser operation timed out',automationRetrying:true}
  ].map((chat,i)=>({workspace:'retry-icons',lastEntryAtMs:now-i,lastEntryEnd:0,totalToolCalls:12,...chat}));
  await page.clock.install({time:now});page.on('pageerror',e=>errors.push(e.message));
  await routeOwner(page,origin+'/**',route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(req.method()!=='GET')writes.push(path);
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   assert.equal(req.headers().authorization,'Bearer retry-test-token');
   if(path==='/api/global')return route.fulfill({json:{version:'2.2.1',plan:null,settingsAvailable:false}});
   if(path==='/api/chats')return route.fulfill({json:{chats,serverTimeMs:Date.now()}});
   if(path.endsWith('/automation'))return route.fulfill({json:{enabled:false}});
   if(path===`/api/chats/${chats[0].id}`)return route.fulfill({json:{_meta:{[META]:{chat_file:'/fixture/CHAT.md',revision:'0',delivered_through:0,read_through:0,last_agent_call_at_ms:now,total_tool_calls:12,server_time_ms:Date.now(),messages:[],has_more:false}}}});
   return route.fulfill({status:404});
  });
  await page.goto(`${origin}/?chat=${chats[0].id}#retry-test-token`);
  const icon=i=>page.locator(`.conversation-row[data-chat-id="${chats[i].id}"] .presence`),circle=icon(1).locator('svg'),ring=icon(2).locator('.goal-outer-ring');
  await icon(1).filter({has:page.locator('.presence-spinner')}).waitFor();await ring.waitFor();
  const checkRed=async()=>{
   assert.equal(await icon(1).getAttribute('class'),'presence retrying');assert.equal(await icon(2).getAttribute('class'),'presence goal-retrying');
   for(const i of [1,2]){assert.equal(await icon(i).evaluate(n=>getComputedStyle(n).color),'rgb(196, 49, 59)');assert.match(await icon(i).getAttribute('aria-label'),/retrying automatically/);assert(await icon(i).isVisible());}
   for(const spin of [circle,ring]){assert.equal(await spin.evaluate(n=>getComputedStyle(n).animationName),'presence-spin');assert.equal(await spin.evaluate(n=>getComputedStyle(n).animationIterationCount),'infinite');}
   assert.equal(await icon(2).locator('path:not(.goal-outer-ring)').evaluate(n=>getComputedStyle(n).animationName),'none','the goal center stays still');
   assert.equal(await page.locator('.presence.error').count(),0);
  };
  await checkRed();assert.equal(await icon(0).evaluate(n=>getComputedStyle(n).color),'rgb(21, 155, 39)');
  for(const spin of [circle,ring]){
   const rotations=await spin.evaluate(n=>{const a=n.getAnimations()[0];a.pause();a.currentTime=0;const before=getComputedStyle(n).transform;a.currentTime=500;const after=getComputedStyle(n).transform;a.play();return {before,after};});
   assert.notEqual(rotations.before,rotations.after,'red recovery icons rotate');
  }
  const out=process.env.RETRY_ICON_SCREENSHOTS;
  if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:`${out}/${name.toLowerCase()}-retrying.png`,animations:'disabled'});}
  await page.emulateMedia({colorScheme:'dark'});for(const i of [1,2])assert.equal(await icon(i).evaluate(n=>getComputedStyle(n).color),'rgb(255, 133, 142)');await page.emulateMedia({colorScheme:'light'});
  // A slow queue remains recovery even after the advertised retry time passes.
  await page.clock.fastForward(60000);await checkRed();
  // The retry clears lastError while preparing and sending, but keeps its marker.
  for(const chat of chats.slice(1))chat.automationError=null;
  await page.clock.fastForward(2100);await page.waitForFunction(()=>![...document.querySelectorAll('.presence[aria-label]')].some(n=>n.getAttribute('aria-label').includes('timed out')));await checkRed();
  for(const chat of chats.slice(1)){chat.automationRetrying=false;chat.automationError='Automatic recovery exhausted; needs attention';}
  await page.clock.fastForward(2100);await icon(1).locator('path[d="M12 6v7m0 4h.01"]').waitFor();await icon(2).locator('path[d="M12 6v7m0 4h.01"]').waitFor();
  for(const i of [1,2]){assert.equal(await icon(i).getAttribute('class'),'presence error');assert.equal(await icon(i).locator('.goal-outer-ring,.presence-spinner').count(),0);assert.equal(await icon(i).locator('svg').evaluate(n=>getComputedStyle(n).animationName),'none');}
  if(out)await page.screenshot({path:`${out}/${name.toLowerCase()}-terminal.png`,animations:'disabled'});
  for(const chat of chats.slice(1)){chat.automationError=null;chat.lastAgentCallAtMs=now+65000;}
  await page.clock.fastForward(2100);await page.locator('.conversation .presence.goal-running').waitFor();assert.equal(await icon(1).getAttribute('class'),'presence online');for(const i of [1,2])assert.equal(await icon(i).evaluate(n=>getComputedStyle(n).color),'rgb(21, 155, 39)');
  for(const chat of chats.slice(1)){chat.automationRetrying=true;chat.automationError='Browser operation timed out';}
  await page.clock.fastForward(2100);await page.locator('.conversation .presence.goal-retrying').waitFor();
  await page.setViewportSize({width:390,height:844});await page.locator('#chat-host').getByRole('button',{name:'Back to chats',exact:true}).click();await checkRed();
  assert.equal(await page.locator('#layout').evaluate(n=>n.scrollWidth>n.clientWidth),false);
  if(out)await page.screenshot({path:`${out}/${name.toLowerCase()}-retrying-mobile.png`,animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser.close();}
});
