import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {ownerHtml,routeOwner} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const META='io.github.devnoname120/codexify/markdown-chat';
const origin='http://127.0.0.1:43238';
const titles=['Bioshock optimization','WAW optimization','OrbStack investigation','Vita CPU overclock investigation','Dopamine 3 RootHide port'];

async function fixture(browser) {
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);
 const now=Date.now(),errors=[],operations=[];let clock=now,failNext=false;
 const chats=titles.map((title,i)=>({id:'abcde'[i].repeat(64),title,workspace:i===2?'orbstack':i===4?'Dopamine2-roothide':'mach-o-vita',projectId:i===2?'orb':i===4?'dopamine':'vita',projectPath:'/projects/'+i,lastEntryEnd:200,lastEntryAtMs:now-i*10000,lastAgentCallAtMs:null,totalToolCalls:12,pinnedAtMs:null,archivedAtMs:i===3?now-30000:i===4?now-20000:null}));
 page.on('pageerror',error=>errors.push(error.message));
 const messages=[{id:'agent-message',role:'agent',markdown:'The latest checks passed. The conversation and its saved files are ready for the next step.',start:0,end:100,created_at_ms:now,tool_call_count:10},{id:'user-message',role:'user',markdown:'Continue from the current progress.',start:100,end:200,created_at_ms:now,tool_call_count:12}];
 await routeOwner(page, origin+'/**',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
  assert.equal(request.headers().authorization,'Bearer test-token');
  if(url.pathname==='/api/global')return route.fulfill({json:{version:'1.7.0',plan:{kind:'pro',label:'Pro 20x'},latest:{updateAvailable:false},settingsAvailable:false,restartAvailable:false}});
  if(url.pathname==='/api/chats') {
   const query=(url.searchParams.get('q')||'').toLowerCase();
   return route.fulfill({json:{chats:[...chats].sort((a,b)=>b.lastEntryAtMs-a.lastEntryAtMs),matchedChatIds:chats.filter(chat=>(chat.title+' '+chat.workspace).toLowerCase().includes(query)).map(chat=>chat.id),serverTimeMs:Date.now()}});
  }
  const id=url.pathname.split('/')[3],chat=chats.find(chat=>chat.id===id);
  assert(chat,'fixture request is confined to a known conversation');
  if(url.pathname.endsWith('/organization')) {
   assert.equal(request.method(),'POST');const body=request.postDataJSON();operations.push({id,body});
   if(failNext){failNext=false;return route.fulfill({status:500,body:'Could not save chat organization'});}
   if(body.archived===true){chat.archivedAtMs=++clock;chat.pinnedAtMs=null;}
   if(body.archived===false)chat.archivedAtMs=null;
   if(body.pinned===true)chat.pinnedAtMs=++clock;
   if(body.pinned===false)chat.pinnedAtMs=null;
   return route.fulfill({json:{pinnedAtMs:chat.pinnedAtMs,archivedAtMs:chat.archivedAtMs}});
  }
  if(url.pathname.endsWith('/send')) {
   const body=request.postDataJSON();operations.push({id,body,send:true});chat.archivedAtMs=null;chat.lastEntryAtMs=++clock;
   return route.fulfill({json:{_meta:{[META]:{sent:{id:body.request_id,end:300,created_at_ms:clock,tool_call_count:12},organization:{pinnedAtMs:null,archivedAtMs:null}}}}});
  }
  if(url.pathname.endsWith('/automation'))return route.fulfill({json:{enabled:true,pairing:{status:'verified'},action:{status:'idle'},goal:null,selection:{model:'gpt-6-astra',effort:'max'},companion:{authenticated:true,status:'idle'},catalog:{models:[{id:'gpt-6-astra',label:'GPT-6 Astra',efforts:[{id:'max',label:'Pro',available:true}]}]},presence:{},serverTimeMs:Date.now()}});
  return route.fulfill({json:{_meta:{[META]:{chat_file:'/fixture/'+id+'/CHAT.md',revision:'200',delivered_through:200,read_through:200,last_agent_call_at_ms:null,total_tool_calls:12,server_time_ms:Date.now(),messages,has_more:false,unchanged:false}}}});
 });
 await page.goto(origin+'/?chat='+chats[0].id+'#test-token');await page.locator('.conversation').first().waitFor();
 return {page,chats,errors,operations,fail:()=>{failNext=true;}};
}
const row=(page,chat)=>page.locator(`.conversation-row[data-chat-id="${chat.id}"]`);
const header=page=>page.locator('#chat-host #chat-title');
const visibleOrder=page=>page.locator('.conversation-row').evaluateAll(rows=>rows.map(row=>row.dataset.chatId));
async function action(page,chat,kind){await row(page,chat).hover();await row(page,chat).locator(`[data-action="${kind}"]`).click();}

for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]) {
 test(`${name}: pins, archives, restores, search and message restoration preserve the requested selection`,{timeout:45000},async()=>{
  const browser=await engine.launch();
  try {
   const {page,chats,operations,errors,fail}=await fixture(browser);const [a,b,c,d,e]=chats;
   assert.deepEqual(await visibleOrder(page),[a.id,b.id,c.id]);
   await action(page,b,'pin');await page.waitForFunction(id=>document.querySelector('.conversation-row')?.dataset.chatId===id,b.id);
   assert.equal(await header(page).textContent(),b.title);assert.equal(new URL(page.url()).searchParams.get('chat'),b.id);
   await page.mouse.move(900,20);assert.equal(await row(page,b).locator('.pin-action').evaluate(node=>getComputedStyle(node).opacity),'1');
   const input=page.locator('#chat-host #draft');await input.fill('Unsent draft');
   await action(page,b,'pin');await page.waitForFunction(id=>document.querySelector(`[data-chat-id="${id}"]`)?.dataset.pinned==='false',b.id);
   assert.equal(await header(page).textContent(),b.title);assert.equal(await input.inputValue(),'Unsent draft','unpinning must not remount the selected conversation');
   await action(page,b,'pin');await page.waitForFunction(id=>document.querySelector('.conversation-row')?.dataset.chatId===id,b.id);
   await action(page,b,'archive');await row(page,b).waitFor({state:'detached'});
   assert.equal(await header(page).textContent(),a.title,'archiving selects the next displayed chat');assert.equal(b.pinnedAtMs,null);assert(b.archivedAtMs!=null);
   assert.equal(await page.locator('#list-view').isVisible(),true);
   await page.getByRole('button',{name:'Archived chats',exact:true}).click();await row(page,b).waitFor();
   assert.deepEqual(await visibleOrder(page),[b.id,e.id,d.id],'archive order uses the archive timestamp, not message time or project');
   assert.equal(await page.locator('#list-view').isVisible(),false);assert.equal(await page.locator('.project-heading').count(),0);
   assert.equal(await page.locator('#chat-search').getAttribute('placeholder'),'Search archived chats…');
   await row(page,d).locator('.conversation').click();assert.equal(await header(page).textContent(),d.title);
   assert.equal(await input.getAttribute('placeholder'),'Message the agent (it will unarchive this chat)…');
   await row(page,d).locator('[data-action="restore"]').click();await row(page,d).waitFor({state:'detached'});
   assert.equal(await header(page).textContent(),d.title,'restoring the selected archive keeps it displayed');
   await row(page,e).locator('[data-action="restore"]').click();await row(page,e).waitFor({state:'detached'});
   assert.equal(await header(page).textContent(),d.title,'restoring another archive does not select it');
   await page.getByRole('button',{name:'Back to agent chats',exact:true}).click();await row(page,a).waitFor();assert.equal(await header(page).textContent(),d.title,'Back preserves the selected restored conversation');
   fail();await action(page,a,'archive');await page.waitForFunction(()=>!document.querySelector('[data-action="archive"]:disabled'));
   assert.equal(await header(page).textContent(),d.title);assert.equal(a.archivedAtMs,null,'failed archive leaves state and selection unchanged');
   const order=await visibleOrder(page);const next=order[order.indexOf(a.id)+1];
   await action(page,a,'archive');await row(page,a).waitFor({state:'detached'});assert.equal(new URL(page.url()).searchParams.get('chat'),next);
   await page.getByRole('button',{name:'Archived chats',exact:true}).click();await row(page,b).waitFor();
   await page.getByRole('searchbox',{name:'Search archived chats',exact:true}).fill('WAW');
   await page.waitForFunction(()=>document.querySelectorAll('.conversation-row').length===1);
   assert.deepEqual(await visibleOrder(page),[b.id]);
   await row(page,b).locator('.conversation').click();await input.fill('Continue this archived chat');await page.locator('#chat-host').getByRole('button',{name:'Send message',exact:true}).click();
   await row(page,b).waitFor({state:'detached'});assert.equal(await header(page).textContent(),b.title);assert.equal(b.archivedAtMs,null);
   await page.getByRole('button',{name:'Back to agent chats',exact:true}).click();await row(page,b).waitFor();
   assert.equal(new URL(page.url()).searchParams.get('chat'),b.id,'Back preserves a conversation restored by sending in the archived view');
   assert.equal(await row(page,b).getAttribute('data-pinned'),'false');
   assert.equal(operations.filter(operation=>operation.send).length,1);
   assert(operations.every(operation=>operation.send||Object.keys(operation.body).length===1),'organization never makes ChatGPT automation requests');
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: normal and archived sidebar controls fit both themes and narrow viewports`,{timeout:45000},async()=>{
  const browser=await engine.launch();
  try {
   const {page,chats,errors}=await fixture(browser);chats[1].pinnedAtMs=Date.now();
   await page.getByRole('button',{name:'Recent',exact:true}).click();await page.waitForTimeout(2200);
   for(const width of [1280,390]) for(const theme of ['light','dark']) for(const archived of [false,true]) {
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const showList=async()=>{const back=page.locator('#chat-host').getByRole('button',{name:'Back to chats',exact:true});if(await back.isVisible())await back.click();};
    await showList();
    if(archived){await page.getByRole('button',{name:'Archived chats',exact:true}).click();await row(page,chats[4]).locator('.conversation').click();}
    else if(await page.locator('#archive-back').isVisible())await page.getByRole('button',{name:'Back to agent chats',exact:true}).click();
    await showList();
    await page.mouse.move(width-10,10);
    const bounds=await page.locator('aside').evaluate(aside=>({overflow:aside.scrollWidth>aside.clientWidth,rows:[...aside.querySelectorAll('.conversation-row')].map(row=>({overflow:row.scrollWidth>row.clientWidth,actions:[...row.querySelectorAll('.conversation-action')].map(button=>{const box=button.getBoundingClientRect();return {right:box.right,left:box.left,width:box.width};})})),right:aside.getBoundingClientRect().right}));
    assert.equal(bounds.overflow,false,`${width} ${theme} sidebar must fit`);
    assert(bounds.rows.every(row=>!row.overflow&&row.actions.every(button=>button.right<=bounds.right&&button.left>=0)),`${width} ${theme} controls remain inside the sidebar`);
    assert.equal(await page.locator('#list-view').isVisible(),!archived);
    const overlaps=await page.locator('.conversation-row').evaluateAll(rows=>rows.some(row=>{
     const dot=row.querySelector('.unread');if(dot.hidden||getComputedStyle(dot).visibility==='hidden')return false;
     const a=dot.getBoundingClientRect();return [...row.querySelectorAll('.conversation-action')].some(button=>{
      if(getComputedStyle(button).opacity==='0')return false;const b=button.getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
     });
    }));
    assert.equal(overlaps,false,'unread dots must not overlap the pin or restore control');
    if(process.env.CODEXIFY_ORGANIZATION_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_ORGANIZATION_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_ORGANIZATION_SCREENSHOTS}/${name.toLowerCase()}-${width}-${theme}-${archived?'archived':'normal'}.png`,fullPage:true});}
    if(!archived&&width===1280&&process.env.CODEXIFY_ORGANIZATION_SCREENSHOTS){await row(page,chats[1]).hover();await page.screenshot({path:`${process.env.CODEXIFY_ORGANIZATION_SCREENSHOTS}/${name.toLowerCase()}-${width}-${theme}-hover.png`,fullPage:true});}
   }
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 test(`${name}: archiving the only active chat clears selection and restore keeps the empty view`,{timeout:30000},async()=>{
  const browser=await engine.launch();
  try {
   const {page,chats,errors}=await fixture(browser);const first=chats[0];
   for(const chat of chats.slice(1))chat.archivedAtMs=Date.now();
   await page.waitForFunction(()=>document.querySelectorAll('.conversation-row').length===1);
   await action(page,first,'archive');await row(page,first).waitFor({state:'detached'});
   assert.equal(new URL(page.url()).searchParams.get('chat'),null);await page.locator('#placeholder').waitFor();
   await page.getByRole('button',{name:'Archived chats',exact:true}).click();await row(page,first).waitFor();
   await row(page,first).locator('[data-action="restore"]').click();await row(page,first).waitFor({state:'detached'});
   assert.equal(await page.locator('#placeholder').isVisible(),true,'restore does not select a conversation');
   await page.getByRole('button',{name:'Back to agent chats',exact:true}).click();await row(page,first).waitFor();
   assert.equal(await header(page).textContent(),first.title);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
}

for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: selected rows hide mouse actions, pinned rows are filled and separated, and Back keeps restored B`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const {page,chats,errors}=await fixture(browser);const [a,b]=chats;
  await row(page,a).locator('.conversation').click();await page.mouse.move(1000,20);await page.waitForTimeout(2200);
  for(const kind of ['archive','pin'])assert.equal(await row(page,a).locator(`[data-action="${kind}"]`).evaluate(node=>getComputedStyle(node).opacity),'0','mouse selection must not leave hover actions visible');
  await row(page,b).hover();for(const kind of ['archive','pin'])assert.equal(await row(page,b).locator(`[data-action="${kind}"]`).evaluate(node=>getComputedStyle(node).opacity),'1');
  await action(page,b,'pin');await page.getByRole('button',{name:'Recent',exact:true}).click();await page.mouse.move(1000,20);
  await page.locator('.pinned-divider').waitFor();assert.equal(await page.locator('.pinned-divider').count(),1);
  assert.notEqual(await row(page,b).locator('.pin-action path').evaluate(node=>getComputedStyle(node).fill),'none');
  assert.equal(await row(page,b).locator('[data-action="archive"]').evaluate(node=>getComputedStyle(node).opacity),'0');
  await row(page,a).locator('.conversation').click();await action(page,b,'archive');await row(page,b).waitFor({state:'detached'});
  await page.getByRole('button',{name:'Archived chats',exact:true}).click();await row(page,b).locator('.conversation').click();
  await page.locator('#chat-host #draft').fill('Unsent draft in B');
  await row(page,b).locator('[data-action="restore"]').click();await row(page,b).waitFor({state:'detached'});
  await page.getByRole('button',{name:'Back to agent chats',exact:true}).click();await row(page,b).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),b.id);assert.equal(await header(page).textContent(),b.title);
  assert.equal(await page.locator('#chat-host #draft').inputValue(),'Unsent draft in B','Back must preserve the restored chat without remounting it');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
