import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const META='io.github.devnoname120/codexify/markdown-chat',ids=['a'.repeat(64),'b'.repeat(64)],modelIds=['gpt-6-astra\x1fmax','gpt-5.6-sol\x1fhigh'];
function fixture(range){
 const n=range==='all'?90:Number(range),today=new Date().toISOString().slice(0,10),daily=[],totals={turns:0,toolCalls:0,activeMs:0,goals:0},models=[{id:modelIds[0],model:'gpt-6-astra',effort:'max',turns:0,toolCalls:0,activeMs:0,goals:0},{id:modelIds[1],model:'gpt-5.6-sol',effort:'high',turns:0,toolCalls:0,activeMs:0,goals:0}];
 for(let i=0;i<n;i++){const day={date:new Date(Date.parse(today)-(n-1-i)*86400000).toISOString().slice(0,10),models:{}};for(let j=0;j<2;j++){const value={turns:(i+j)%4+1,toolCalls:(i+j+1)*8,activeMs:((i+j)%5+1)*12*60000,goals:(i+j)%5===0?1:0};day.models[modelIds[j]]=value;for(const key of Object.keys(totals)){totals[key]+=value[key];models[j][key]+=value[key];}}daily.push(day);}
 return {today,timezone:'CEST',since:Date.now()-120*86400000,daily,models,totals,lifetime:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v*3])),activeDays:n,streak:4,conversations:[{id:ids[0],turns:27,toolCalls:900,activeMs:5400000,goals:3},{id:ids[1],turns:14,toolCalls:1600,activeMs:10800000,goals:1}]};
}
for(const [name,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: colorful analytics use the full panel, stay always on, and preserve charts and silent failures`,{timeout:45000},async()=>{
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(7000);
  const errors=[],writes=[],reads=[];page.on('pageerror',e=>errors.push(e.message));let fail=false,malformed=false,revision=1;
  const config={agentChat:{analyticsEnabled:false,turnRenewal:{enabled:false,limits:[]}}},snapshot=()=>({document:config,defaults:{agentChat:{analyticsEnabled:true}},raw:JSON.stringify(config),path:'/fixture/config.json',revision:String(revision),restartRequired:false});
  await routeOwner(page,'http://127.0.0.1:43318/**',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   assert.equal(request.headers().authorization,'Bearer test-token');
   if(request.method()!=='GET')writes.push({path,body:request.postDataJSON()});
   if(path==='/api/global')return route.fulfill({json:{version:'2.0.0',settingsAvailable:true,restartAvailable:true}});
   if(path==='/api/chats')return route.fulfill({json:{chats:ids.map((id,i)=>({id,title:['BioShock optimization','Reader annotations'][i],workspace:['mach-o-vita','epubviewer'][i],lastEntryAtMs:Date.now(),totalToolCalls:0})),serverTimeMs:Date.now()}});
   if(path==='/api/settings'&&request.method()==='GET')return route.fulfill({json:snapshot()});
   if(path==='/api/settings')assert.fail('Analytics must never write a collection setting');
   if(path==='/api/analytics/turn-cutoffs')return route.fulfill({json:{models:[],samples:0}});
   if(path==='/api/analytics/usage'){reads.push(url.searchParams.get('days'));if(fail)return route.fulfill({status:500,body:'private disk error'});return route.fulfill({json:malformed?{models:[null,42],daily:[null,{date:'bad'}],conversations:[null],totals:{turns:-1}}:fixture(url.searchParams.get('days'))});}
   if(path.endsWith('/automation'))return route.fulfill({json:{enabled:false,pairing:{status:'unpaired'},action:{status:'idle'},catalog:{models:[]},selection:{},presence:{},serverTimeMs:Date.now()}});
   if(ids.some(id=>path===`/api/chats/${id}`))return route.fulfill({json:{_meta:{[META]:{messages:[],revision:'0',chat_file:'/fixture/CHAT.md',last_agent_call_at_ms:null,server_time_ms:Date.now(),total_tool_calls:0,has_more:false}}}});
   return route.fulfill({status:404});
  });
  await page.goto('http://127.0.0.1:43318/#test-token');await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Codexify settings'}),nav=dialog.locator('#settings-nav');assert.equal(await nav.locator('button').last().textContent(),'Analytics');
  await dialog.getByRole('button',{name:'Analytics',exact:true}).click();const dashboard=dialog.locator('#usage-analytics');await dashboard.getByText('CEST',{exact:false}).first().waitFor();
  assert(await dialog.locator('#settings-sidebar').isHidden(),'the vertical settings ribbon is removed from analytics');
  assert(await dialog.locator('.settings-footer').isHidden(),'maintenance controls do not occupy dashboard space');
  assert(await dialog.getByRole('button',{name:'Back to settings',exact:true}).isVisible());
  assert.equal(await dashboard.getByLabel('Collect analytics',{exact:true}).count(),0);
  const backgrounds=await dashboard.locator('.analytics-kpi').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));assert.equal(new Set(backgrounds).size,4,'each metric has its own color');
  const main=await dialog.locator('#settings-main').boundingBox(),bounds=await dialog.boundingBox();assert(main.width>bounds.width*.9,'the dashboard uses the full dialog width');
  assert.equal(await dashboard.getByLabel('Analytics date range').inputValue(),'7');assert.deepEqual(reads,['7']);assert.equal(await dashboard.locator('.analytics-kpi').count(),4);assert.equal(await dashboard.getByRole('img').count(),3);
  const card=dashboard.locator('.analytics-card').filter({hasText:'Conversation league'});assert.equal(await card.locator('.analytics-chat-link').first().textContent(),'BioShock optimization');await card.getByRole('button',{name:'Active time',exact:true}).click();assert.equal(await card.locator('.analytics-chat-link').first().textContent(),'Reader annotations');
  const legend=dashboard.locator('.analytics-legend button').first();await legend.click();assert.equal(await dashboard.locator('.analytics-legend button').first().getAttribute('aria-pressed'),'false');await dashboard.locator('.analytics-legend button').first().click();
  await dashboard.getByLabel('Analytics date range').selectOption('30');await page.waitForFunction(()=>document.querySelector('.analytics-hero h4')?.textContent==='The last 30 days'&&!document.querySelector('[aria-label="Refresh analytics"]:disabled'));assert.equal(reads.at(-1),'30');
  const out=process.env.ANALYTICS_SCREENSHOT_DIR;if(out){mkdirSync(out,{recursive:true});await dialog.locator('#settings-main').evaluate(n=>n.scrollTop=0);await page.screenshot({animations:'disabled',path:`${out}/${name.toLowerCase()}-desktop.png`});}
  if(out){await card.scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${out}/${name.toLowerCase()}-leaderboard.png`});await dashboard.getByRole('heading',{name:'Momentum',exact:true}).locator('..').scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${out}/${name.toLowerCase()}-momentum.png`});await dialog.locator('#settings-main').evaluate(n=>n.scrollTop=0);}
  await page.emulateMedia({colorScheme:'dark'});if(out)await page.screenshot({animations:'disabled',path:`${out}/${name.toLowerCase()}-dark.png`});
  await page.setViewportSize({width:375,height:950});await dialog.locator('#settings-main').evaluate(n=>n.scrollTop=0);assert.equal(await dialog.evaluate(n=>n.scrollWidth>n.clientWidth),false);assert.equal(await dashboard.evaluate(n=>n.scrollWidth>n.clientWidth),false);if(out)await page.screenshot({animations:'disabled',path:`${out}/${name.toLowerCase()}-mobile.png`});
  const controls=await dashboard.locator('.analytics-controls').evaluate(node=>[...node.children].map(n=>{const b=n.getBoundingClientRect();return b.top+b.height/2;}));assert(Math.max(...controls)-Math.min(...controls)<5,'mobile controls stay on one row');
  assert.equal(await dashboard.getByLabel('Collect analytics',{exact:true}).count(),0);assert.equal(writes.length,0);
  const prior=await dashboard.locator('.analytics-kpi-value').allTextContents();fail=true;await dashboard.getByRole('button',{name:'Refresh analytics',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh analytics"]:disabled'));assert.deepEqual(await dashboard.locator('.analytics-kpi-value').allTextContents(),prior);assert.equal(await dialog.locator('#settings-save-state').getAttribute('data-error'),'false');assert.equal(await page.getByText('private disk error').count(),0);
  fail=false;malformed=true;await dashboard.getByLabel('Analytics date range').selectOption('all');await dashboard.getByText('Your next turn starts the story.',{exact:false}).waitFor();await dialog.getByRole('button',{name:'Back to settings',exact:true}).click();assert(await nav.isVisible());assert.equal(await dialog.getByLabel('agentChat.analyticsEnabled',{exact:true}).count(),0);await dialog.getByRole('button',{name:'Analytics',exact:true}).click();assert.deepEqual(errors,[]);assert.equal(writes.length,0);
 }finally{await browser.close();}
});
