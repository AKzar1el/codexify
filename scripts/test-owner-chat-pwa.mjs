import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {ownerHtml} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const assets=new Map([['/manifest.webmanifest',['application/manifest+json','manifest.webmanifest']],...['180','192','512'].map(n=>[`/icons/app-${n}.png`,['image/png',`app-${n}.png`]])]);
const token='pwa-test-access-token',id='a'.repeat(64);
for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: Home Screen metadata, icons and private launch work without extra web features`,{timeout:30000},async()=>{
 const requests=[],errors=[];
 const server=createServer((request,response)=>{
  requests.push({url:request.url,method:request.method});response.setHeader('Cache-Control','no-store');
  const path=new URL(request.url,'http://fixture.invalid').pathname;
  if(path==='/'){response.setHeader('Content-Type','text/html');response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; manifest-src 'self'; base-uri 'none'");response.end(ownerHtml);return;}
  if(assets.has(path)){const[mime,file]=assets.get(path);response.setHeader('Content-Type',mime);response.end(readFileSync(new URL('../src/owner_chat/pwa/'+file,import.meta.url)));return;}
  if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(401);response.end('Unauthorized');return;}
  response.setHeader('Content-Type','application/json');
  if(path==='/api/global'){response.end(JSON.stringify({version:'2.0.0',settingsAvailable:false,latest:{updateAvailable:false}}));return;}
  if(path==='/api/chats'){response.end(JSON.stringify({chats:[{id,title:'Home Screen fixture',workspace:'fixture',lastEntryEnd:0,lastEntryAtMs:Date.now(),totalToolCalls:0}],serverTimeMs:Date.now()}));return;}
  response.writeHead(404);response.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await engine.launch();try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));const launch=base+'/?from=bookmark#'+token;await page.goto(launch);await page.locator('.conversation').first().waitFor();
  assert.equal(await page.locator('link[rel=manifest]').getAttribute('crossorigin'),'use-credentials');assert.equal(await page.locator('meta[name=apple-mobile-web-app-capable]').getAttribute('content'),'yes');assert.equal(await page.locator('meta[name=apple-mobile-web-app-title]').getAttribute('content'),'Codexify');
  const manifestUrl=await page.locator('link[rel=manifest]').getAttribute('href'),manifestResponse=await context.request.get(base+manifestUrl);assert.equal(manifestResponse.status(),200);assert.match(manifestResponse.headers()['content-type'],/^application\/manifest\+json/);const raw=await manifestResponse.text(),manifest=JSON.parse(raw);assert(!raw.includes(token));assert.equal(manifest.display,'standalone');assert.equal(manifest.id,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.start_url,undefined,'use the existing private URL instead of dropping its fragment');
  for(const[src,size]of [[await page.locator('link[rel=apple-touch-icon]').getAttribute('href'),180],...manifest.icons.map(i=>[i.src,Number(i.sizes.split('x')[0])])]){
   const response=await context.request.get(base+src),bytes=await response.body();assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/^image\/png/);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);assert(bytes.length<20000);
  }
  if(name==='Chromium'){
   const session=await context.newCDPSession(page),result=await session.send('Page.getAppManifest');assert.deepEqual(result.errors,[]);assert.equal(result.manifest?.display,'kStandalone');assert.equal(result.manifest?.startUrl,launch,'browser-computed launch URL preserves authentication');assert.equal(result.manifest?.id,base+'/');assert.deepEqual((await session.send('Page.getInstallabilityErrors')).installabilityErrors,[]);
  }
  assert.equal(await page.locator('body').evaluate(n=>n.scrollWidth>innerWidth),false);assert.deepEqual(await page.evaluate(async()=>await navigator.serviceWorker.getRegistrations().then(v=>v.map(r=>r.scope))),[]);assert.equal(await page.evaluate(()=>localStorage.getItem('owner-chat-token')),null);
  await context.close();
  // A Home Screen launch has its own browsing context, not the tab's sessionStorage.
  const fresh=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),opened=await fresh.newPage();opened.on('pageerror',e=>errors.push(e.message));await opened.goto(launch);await opened.locator('.conversation').first().waitFor();assert.equal(await opened.evaluate(()=>sessionStorage.getItem('owner-chat-token')),token);await fresh.close();
  const existing=await browser.newContext();await existing.addInitScript(token=>sessionStorage.setItem('owner-chat-token',token),token);const bare=await existing.newPage();bare.on('pageerror',e=>errors.push(e.message));await bare.goto(base+'/');await bare.locator('.conversation').first().waitFor();assert.equal(new URL(bare.url()).hash,'#'+token,'an authenticated bare URL becomes a reusable private Home Screen URL');if(name==='Chromium'){const session=await existing.newCDPSession(bare);assert.equal((await session.send('Page.getAppManifest')).manifest?.startUrl,bare.url());}await existing.close();
  assert.deepEqual(errors,[]);assert(requests.every(r=>r.method==='GET'));assert(requests.every(r=>!r.url.includes(token)),'private access fragments never appear in HTTP request URLs');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
