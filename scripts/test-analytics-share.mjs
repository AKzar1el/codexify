import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const origin='http://127.0.0.1:43329',today='2026-10-17';
const numbers={7:{turns:84,toolCalls:12480,goals:9},30:{turns:328,toolCalls:50321,goals:27},90:{turns:820,toolCalls:150000,goals:84},all:{turns:1240,toolCalls:284000,goals:119}};
async function fixture(engine,{clipboard=true}={}){
 const browser=await engine.launch(),page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);const errors=[],requests=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith(origin))requests.push(new URL(r.url()).pathname);if(r.method()!=='GET')posts.push(new URL(r.url()).pathname);});
 await page.addInitScript(({clipboard})=>{
  // Stop unrelated sidebar polling so this fixture audits only export requests.
  window.setInterval=()=>0;
  window.__drawn=[];window.__copyFailed=false;window.__copyActivation=null;
  const fill=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__drawn.push(String(text));return fill.call(this,text,...args);};
  if(clipboard){
   window.ClipboardItem??=class {constructor(data){this.data=data;this.types=Object.keys(data);}getType(type){return Promise.resolve(this.data[type]);}};
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write(items){window.__copyActivation=navigator.userActivation?.isActive??null;window.__copied=items[0];return window.__copyFailed?Promise.reject(new DOMException('Denied','NotAllowedError')):Promise.resolve();}}});
  }else Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
 },{clipboard});
 await routeOwner(page,origin+'/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
  assert.equal(request.headers().authorization,'Bearer share-test-token');
  if(path==='/api/global')return route.fulfill({json:{version:'2.0.0',settingsAvailable:true}});
  if(path==='/api/chats')return route.fulfill({json:{chats:[],serverTimeMs:Date.now()}});
  if(path==='/api/settings')return route.fulfill({json:{document:{},defaults:{agentChat:{analyticsEnabled:true}},revision:'1',path:'/private/secret-project/config.json',raw:'{}'}});
  if(path==='/api/analytics/turn-cutoffs')return route.fulfill({json:{models:[],samples:0}});
  if(path==='/api/analytics/usage'){
   const days=url.searchParams.get('days'),totals={...numbers[days],activeMs:12345678};
   return route.fulfill({json:{today,timezone:'CEST',since:1700000000000,totals,lifetime:totals,activeDays:7,streak:4,models:[{id:'private-model\x1fhigh',model:'PRIVATE-MODEL',effort:'high',...totals}],daily:[{date:'2026-10-11',models:{model:{turns:8}}},{date:today,models:{model:{turns:21}}}],conversations:[{id:'a'.repeat(64),title:'Private project secret',path:'/Users/private/secret-project',...totals}]}});
  }
  return route.fulfill({status:404});
 });
 await page.goto(origin+'/#share-test-token');await page.getByRole('button',{name:'Codexify settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Codexify settings'});await settings.getByRole('button',{name:'Analytics',exact:true}).click();await settings.getByRole('button',{name:'Share analytics',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('[aria-label="Share analytics"]').disabled);
 return {browser,page,settings,errors,requests,posts};
}
async function ready(page){const dialog=page.getByRole('dialog',{name:'Share your stats'});await dialog.locator('#stats-share-download[aria-disabled=false]').waitFor();await page.waitForFunction(()=>{const image=document.getElementById('stats-share-image');return image?.complete&&image.naturalWidth===1200;});return dialog;}
function png(bytes){assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),1200);assert.equal(bytes.readUInt32BE(20),675);assert(bytes.length<400000,'compact PNG should stay small');}
for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: share cards export the selected period as a private PNG and copy the same image`,{timeout:45000},async()=>{
 const f=await fixture(engine),{browser,page,settings,errors,requests,posts}=f;const output=process.env.ANALYTICS_SHARE_SCREENSHOTS||mkdtempSync(join(tmpdir(),'analytics-share-'));mkdirSync(output,{recursive:true});
 try{
  const range=settings.getByLabel('Analytics date range');
  for(const period of ['7','30','90','all']){
   await range.selectOption(period);await page.waitForFunction(()=>!document.querySelector('[aria-label="Share analytics"]').disabled);
   await page.evaluate(()=>{window.__drawn=[];});const before=requests.length;await settings.getByRole('button',{name:'Share analytics',exact:true}).click();const dialog=await ready(page);
   assert.match(await dialog.locator('#stats-share-description').textContent(),period==='all'?/Lifetime/:new RegExp(`Last ${period} days`));
   assert.equal(await dialog.locator('img').getAttribute('src').then(v=>v.startsWith('blob:')),true);
   const text=await page.evaluate(()=>window.__drawn);assert(text.includes('Codexify stats'));assert(text.includes('codexify.dev'));assert(text.includes('Turns'));assert(text.includes('Tool calls'));assert(text.includes('Goals completed'));assert(text.some(t=>t===String(numbers[period].turns)||t===new Intl.NumberFormat('en-US').format(numbers[period].turns)));
   assert(!text.some(t=>/secret|private|share-test-token|127\.0\.0\.1|chatgpt\.com/i.test(t)),'only aggregate totals and public branding belong on the card');
   const pending=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download PNG',exact:true}).click();const download=await pending;
   assert.equal(download.suggestedFilename(),`codexify-stats-${period==='all'?'lifetime':period+'-days'}-${today}.png`);const path=join(output,`${name.toLowerCase()}-${period}.png`);await download.saveAs(path);const bytes=readFileSync(path);png(bytes);
   await dialog.getByRole('button',{name:'Copy image',exact:true}).click();await dialog.getByText('Image copied.',{exact:true}).waitFor();
   const copied=await page.evaluate(async()=>Array.from(new Uint8Array(await(await window.__copied.getType('image/png')).arrayBuffer())));assert.equal(createHash('sha256').update(Buffer.from(copied)).digest('hex'),createHash('sha256').update(bytes).digest('hex'));assert.notEqual(await page.evaluate(()=>window.__copyActivation),false,'clipboard write must keep the click gesture');
   assert.equal(requests.length,before,'generation, copy and download must not make server requests');assert.deepEqual(posts,[]);
   if(period==='7'&&process.env.ANALYTICS_SHARE_SCREENSHOTS){await page.screenshot({animations:'disabled',path:join(output,`${name.toLowerCase()}-preview.png`)});await page.setViewportSize({width:375,height:850});const box=await dialog.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=375);assert.equal(await dialog.evaluate(n=>n.scrollWidth>n.clientWidth),false);await page.screenshot({animations:'disabled',path:join(output,`${name.toLowerCase()}-mobile.png`)});await page.setViewportSize({width:1440,height:1000});}
   await dialog.getByRole('button',{name:'Close share preview',exact:true}).click();assert.equal(await settings.isVisible(),true);
  }
  await settings.getByRole('button',{name:'Share analytics',exact:true}).click();await ready(page);await page.mouse.click(3,3);assert.equal(await page.getByRole('dialog',{name:'Share your stats'}).isVisible(),false);assert.equal(await settings.isVisible(),true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: clipboard denial and unsupported copy keep PNG download available`,{timeout:30000},async()=>{
 for(const clipboard of [true,false]){
  const {browser,page,settings,errors,posts}=await fixture(engine,{clipboard});try{
   await settings.getByRole('button',{name:'Share analytics',exact:true}).click();const dialog=await ready(page);
   if(clipboard){await page.evaluate(()=>{window.__copyFailed=true;});await dialog.getByRole('button',{name:'Copy image',exact:true}).click();await dialog.getByText('Couldn’t copy the image. Use Download PNG, or try again.',{exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Copy image',exact:true}).isEnabled(),true);}
   else{assert.equal(await dialog.getByRole('button',{name:'Copy image',exact:true}).isDisabled(),true);await dialog.getByText('Copy isn’t available in this browser. Download the PNG instead.',{exact:true}).waitFor();}
   const pending=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download PNG',exact:true}).click();await pending;
   await page.keyboard.press('Escape');assert.equal(await settings.isVisible(),true);assert.equal(await settings.locator('#settings-save-state').getAttribute('data-error'),'false');assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
  }finally{await browser.close();}
 }
});

for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: unavailable canvas stays inside the share preview`,{timeout:30000},async()=>{
 const {browser,page,settings,errors,posts}=await fixture(engine);try{
  await page.evaluate(()=>{HTMLCanvasElement.prototype.getContext=()=>null;});await settings.getByRole('button',{name:'Share analytics',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Share your stats'});await dialog.getByText('The image could not be created.',{exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Copy image',exact:true}).isDisabled(),true);assert.equal(await dialog.getByRole('link',{name:'Download PNG',exact:true}).count(),0);
  await dialog.getByRole('button',{name:'Close share preview',exact:true}).click();assert.equal(await settings.getByRole('button',{name:'Share analytics',exact:true}).isEnabled(),true);assert.equal(await settings.locator('#settings-save-state').getAttribute('data-error'),'false');assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
 }finally{await browser.close();}
});

for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: animated SVG downloads locally, counts up in an image, and retains PNG copying`,{timeout:45000},async()=>{
 const {browser,page,settings,errors,requests,posts}=await fixture(engine),output=process.env.ANALYTICS_SHARE_SCREENSHOTS||mkdtempSync(join(tmpdir(),'analytics-motion-'));mkdirSync(output,{recursive:true});
 try{
  for(const period of ['7','30','90','all']){
   await settings.getByLabel('Analytics date range').selectOption(period);await page.waitForFunction(()=>!document.querySelector('[aria-label="Share analytics"]').disabled);
   const before=requests.length;await settings.getByRole('button',{name:'Share analytics',exact:true}).click();const dialog=await ready(page);
   await dialog.getByRole('button',{name:'Animated SVG',exact:true}).click();await dialog.getByRole('link',{name:'Download SVG',exact:true}).waitFor();
   const source=await dialog.locator('img').getAttribute('src');assert(source.startsWith('blob:'));
   const pending=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download SVG',exact:true}).click();const download=await pending;assert.equal(download.suggestedFilename(),`codexify-stats-${period==='all'?'lifetime':period+'-days'}-${today}.svg`);
   const path=join(output,`${name.toLowerCase()}-${period}.svg`);await download.saveAs(path);const svg=readFileSync(path,'utf8');assert.equal(await page.evaluate(async source=>(await fetch(source)).text(),source),svg,'download and live preview use identical SVG bytes');
   assert(svg.length<60000);assert(svg.includes('prefers-reduced-motion'));assert(!/secret|private|share-test-token|127\.0\.0\.1|chatgpt\.com|foreignObject|<script|<image|href=|@import|onload=/i.test(svg));
   const xml=await page.evaluate(svg=>{const d=new DOMParser().parseFromString(svg,'image/svg+xml');return {error:!!d.querySelector('parsererror'),dimensions:[d.documentElement.getAttribute('width'),d.documentElement.getAttribute('height')],final:[...d.querySelectorAll('[data-final]')].map(n=>n.textContent),animated:d.querySelectorAll('animateTransform').length,desc:d.querySelector('desc')?.textContent};},svg);
   assert.equal(xml.error,false);assert.deepEqual(xml.dimensions,['1200','675']);assert(xml.animated>=3);assert(xml.desc.includes(`${numbers[period].toolCalls} tool calls`));
   assert.equal(xml.final[0],new Intl.NumberFormat('en-US',{notation:numbers[period].turns>=10000?'compact':'standard'}).format(numbers[period].turns));
   await dialog.getByRole('button',{name:'Pause preview',exact:true}).click();assert.notEqual(await dialog.locator('img').getAttribute('src'),source);
   await dialog.getByRole('button',{name:'Copy PNG',exact:true}).click();await dialog.getByText('Image copied.',{exact:true}).waitFor();const copied=await page.evaluate(async()=>Array.from(new Uint8Array(await(await window.__copied.getType('image/png')).arrayBuffer())));png(Buffer.from(copied));
   await dialog.getByRole('button',{name:'Play preview',exact:true}).click();assert.equal(await dialog.locator('img').getAttribute('src'),source);
   if(period==='7'){
    await page.setViewportSize({width:375,height:850});assert.equal(await dialog.evaluate(n=>n.scrollWidth>n.clientWidth),false);await page.screenshot({path:join(output,`${name.toLowerCase()}-animated-mobile.png`)});await page.setViewportSize({width:1440,height:1000});
    // Test the exported file in the same restricted image context used by a
    // README: no SVG scripts execute, and no external resources are requested.
    const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:1200,height:675},deviceScaleFactor:1});const frame=await context.newPage();let imageRequests=0;
    await frame.route('http://127.0.0.1:43330/**',route=>{imageRequests++;return route.fulfill({contentType:route.request().url().endsWith('.svg')?'image/svg+xml':'text/html',body:route.request().url().endsWith('.svg')?svg:'<style>body{margin:0}img{display:block;width:1200px;height:675px}</style><img src="/stats.svg" alt="Stats">'});});
    await frame.goto('http://127.0.0.1:43330/');await frame.locator('img').waitFor();await frame.waitForTimeout(150);const early=await frame.screenshot({path:join(output,`${name.toLowerCase()}-motion-start.png`)});await frame.waitForTimeout(700);const middle=await frame.screenshot({path:join(output,`${name.toLowerCase()}-motion-count.png`)});assert.notDeepEqual(early,middle,'SVG must animate as an image without JavaScript');
    await frame.waitForTimeout(1200);await frame.screenshot({path:join(output,`${name.toLowerCase()}-motion-fire.png`)});await frame.waitForTimeout(2100);const final=await frame.screenshot({path:join(output,`${name.toLowerCase()}-motion-final.png`)});await frame.waitForTimeout(550);assert.equal(createHash('sha256').update(await frame.screenshot()).digest('hex'),createHash('sha256').update(final).digest('hex'),'final totals must hold still before the loop restarts');assert.equal(imageRequests,2);await context.close();
   }
   assert.equal(requests.length,before,'export makes no requests');await dialog.getByRole('button',{name:'Close share preview',exact:true}).click();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
 }finally{await browser.close();}
});

for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: reduced-motion SVG is still and SVG export survives unavailable canvas`,{timeout:30000},async()=>{
 const {browser,page,settings,errors,posts}=await fixture(engine);try{
  await page.emulateMedia({reducedMotion:'reduce'});await settings.getByRole('button',{name:'Share analytics',exact:true}).click();const dialog=await ready(page);await dialog.getByRole('button',{name:'Animated SVG',exact:true}).click();
  await dialog.getByRole('button',{name:'Motion reduced',exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Motion reduced',exact:true}).isDisabled(),true);
  await page.waitForFunction(()=>document.getElementById('stats-share-image').complete);const first=await dialog.locator('img').screenshot();await page.waitForTimeout(700);assert.equal(createHash('sha256').update(await dialog.locator('img').screenshot()).digest('hex'),createHash('sha256').update(first).digest('hex'),'reduced motion must keep exact final totals visible');
  // Check the exported file's own media rule separately: page-level browser
  // emulation is not inherited by SVG image subdocuments on every engine.
  const svg=await page.evaluate(async()=>{const link=document.getElementById('stats-share-download');return(await fetch(link.href)).text();});
  const context=await browser.newContext({reducedMotion:'reduce',viewport:{width:1200,height:675}}),standalone=await context.newPage();
  await standalone.route('http://127.0.0.1:43331/stats.svg',r=>r.fulfill({contentType:'image/svg+xml',body:svg}));await standalone.goto('http://127.0.0.1:43331/stats.svg');
  assert.equal(await standalone.evaluate(()=>[...document.querySelectorAll('.motion')].every(n=>getComputedStyle(n).display==='none')),true);
  await standalone.evaluate(()=>document.documentElement.setCurrentTime(.5));const still=await standalone.screenshot();await standalone.evaluate(()=>document.documentElement.setCurrentTime(2.5));assert.equal(createHash('sha256').update(await standalone.screenshot()).digest('hex'),createHash('sha256').update(still).digest('hex'));await context.close();
  await dialog.getByRole('button',{name:'Close share preview',exact:true}).click();
  await page.evaluate(()=>{HTMLCanvasElement.prototype.getContext=()=>null;});await settings.getByRole('button',{name:'Share analytics',exact:true}).click();await dialog.getByText('The image could not be created.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Animated SVG',exact:true}).click();await dialog.getByRole('link',{name:'Download SVG',exact:true}).waitFor();await page.waitForFunction(()=>document.getElementById('stats-share-image').naturalWidth===1200);assert.equal(await dialog.getByRole('button',{name:'Copy PNG',exact:true}).isDisabled(),true);
  const pending=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download SVG',exact:true}).click();await pending;assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
 }finally{await browser.close();}
});
