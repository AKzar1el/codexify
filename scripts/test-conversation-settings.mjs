import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
import {ownerHtml} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const META='io.github.devnoname120/codexify/markdown-chat';

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: conversation settings match the global modal and preserve chat layout`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:980}});page.setDefaultTimeout(5000);
  const id='a'.repeat(64),now=Date.now(),errors=[],operations=[];
  page.on('pageerror',error=>errors.push(error.message));
  const state={enabled:true,pairing:{status:'verified',canonicalUrl:'https://chatgpt.com/c/example-conversation'},goal:{status:'active',markdown:'Continue the investigation',revision:1,elapsedActiveMs:3600000,turnCount:2},selection:{model:'gpt-6-astra',effort:'max'},catalog:{models:[{id:'gpt-6-astra',label:'GPT-6 Astra',efforts:[{id:'max',label:'Pro',available:true}]}]},companion:{authenticated:true,status:'idle'},presence:{lastAgentCallAtMs:now},action:{status:'failed',kind:'offline_chat',id:'failed-action',lastError:'The browser could not send the message.',retryMode:'retry'}};
  const defaults=JSON.parse(readFileSync(new URL('../codexify.config.example.json',import.meta.url)));
  await page.route('http://127.0.0.1:43302/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(path==='/api/global')return route.fulfill({json:{version:'1.7.0',plan:{label:'Pro 20x'},settingsAvailable:true,restartAvailable:true,latest:{updateAvailable:false}}});
   if(path==='/api/settings')return route.fulfill({json:{path:'/fixture/config.json',defaults,document:{workDir:'/fixture'},raw:'{"workDir":"/fixture"}',revision:'1'}});
   if(path==='/api/chats')return route.fulfill({json:{chats:[{id,title:'Bioshock optimization',workspace:'mach-o-vita',lastEntryAtMs:now,lastEntryEnd:4000,lastAgentCallAtMs:now,totalToolCalls:40}],serverTimeMs:Date.now()}});
   if(path.endsWith('/automation'))return route.fulfill({json:{...state,serverTimeMs:Date.now()}});
   if(request.method()==='POST'){
    operations.push([path,request.postDataJSON()]);
    if(path.endsWith('/action/retry')){state.action={...state.action,status:'queued',lastError:null};return route.fulfill({json:{action:state.action}});}
    if(path.endsWith('/reveal'))return route.fulfill({json:{opened:true}});
    return route.fulfill({status:405,body:'Unexpected mutation'});
   }
   return route.fulfill({json:{_meta:{[META]:{chat_file:'/fixture/CHAT.md',revision:'4000',messages:Array.from({length:24},(_,i)=>({id:`progress-${i}`,role:'agent',markdown:'The investigation is in progress. '.repeat(7),start:i*100,end:(i+1)*100,created_at_ms:now,tool_call_count:i+1})),delivered_through:0,read_through:0,total_tool_calls:40,last_agent_call_at_ms:now,server_time_ms:Date.now(),has_more:false,unchanged:false}}}});
  });
  await page.goto(`http://127.0.0.1:43302/?chat=${id}#fixture-token`);
  const host=page.locator('#chat-host'),toggle=host.getByRole('button',{name:'Connection settings',exact:true});
  await toggle.waitFor();await host.locator('.message').last().waitFor();
  await host.getByRole('textbox',{name:'Message the agent',exact:true}).fill('A multiline\ndraft remains\nunchanged.');
  await host.locator('#messages').evaluate(element=>element.scrollTop=element.scrollHeight-element.clientHeight-100);
  const geometry=()=>host.locator('#messages').evaluate(element=>{const root=element.getRootNode(),composer=root.querySelector('#composer');return {top:element.scrollTop,height:element.clientHeight,composerY:composer.getBoundingClientRect().y};});
  const before=await geometry();await toggle.click();
  const dialog=host.getByRole('dialog',{name:'Conversation settings',exact:true});await dialog.waitFor();
  assert.equal(await dialog.getByText('Bioshock optimization',{exact:true}).count(),1);
  assert.deepEqual(await dialog.getByRole('heading',{level:3}).allTextContents(),['Browser connection','Paired conversation','Activity & recovery']);
  assert.equal(await dialog.evaluate(element=>element.open&&element.matches(':modal')),true);
  const box=await dialog.boundingBox();assert(Math.abs(box.x+box.width/2-720)<1&&Math.abs(box.y+box.height/2-490)<1,'dialog is centered in the viewport rather than over the composer');
  assert.deepEqual(await geometry(),before);
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  const dialogStyle=await dialog.evaluate(element=>{const style=getComputedStyle(element),backdrop=getComputedStyle(element,'::backdrop');return {shadow:style.boxShadow,radius:style.borderRadius,backdrop:backdrop.backgroundColor,blur:backdrop.backdropFilter};});
  assert.notEqual(dialogStyle.shadow,'none');assert.equal(dialogStyle.radius,'20px');assert.equal(dialogStyle.blur,'blur(5px)');
  const url=dialog.getByLabel('ChatGPT conversation URL');await url.fill('https://chatgpt.com/c/edited-draft');
  await page.waitForTimeout(1700);assert.equal(await url.inputValue(),'https://chatgpt.com/c/edited-draft','background polls preserve focused URL edits');
  for(let i=0;i<10;i++){await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(element=>element.contains(element.getRootNode().activeElement)),true,'keyboard focus stays inside the modal');}
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.equal(await toggle.evaluate(element=>element===element.getRootNode().activeElement),true,'Escape restores focus to the cog');
  assert.equal(await host.getByRole('textbox',{name:'Message the agent',exact:true}).inputValue(),'A multiline\ndraft remains\nunchanged.');
  await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const global=page.getByRole('dialog',{name:'Codexify settings',exact:true});await global.getByLabel('workDir',{exact:true}).waitFor();
  const globalStyle=await global.evaluate(element=>({shadow:getComputedStyle(element).boxShadow,backdrop:getComputedStyle(element,'::backdrop').backgroundColor,blur:getComputedStyle(element,'::backdrop').backdropFilter}));
  assert.equal(dialogStyle.shadow,globalStyle.shadow);assert.equal(dialogStyle.backdrop,globalStyle.backdrop);assert.equal(dialogStyle.blur,globalStyle.blur);
  await global.getByRole('button',{name:'Close settings'}).click();
  for(const colorScheme of ['light','dark'])for(const viewport of [{width:1440,height:980},{width:375,height:650}]){
   await page.emulateMedia({colorScheme});await page.setViewportSize(viewport);await toggle.click();
   const bounds=await dialog.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y>=0&&bounds.y+bounds.height<=viewport.height);
   const header=await dialog.locator('.connection-settings-header').boundingBox(),footer=await dialog.locator('.connection-settings-footer').boundingBox();
   await dialog.locator('.connection-settings-body').evaluate(element=>element.scrollTop=10000);
   assert.deepEqual(await dialog.locator('.connection-settings-header').boundingBox(),header);assert.deepEqual(await dialog.locator('.connection-settings-footer').boundingBox(),footer);
   assert.equal(await dialog.evaluate(element=>element.scrollWidth>element.clientWidth),false);
   if(process.env.CODEXIFY_SETTINGS_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_SETTINGS_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_SETTINGS_SCREENSHOTS}/${engineName.toLowerCase()}-conversation-settings-${colorScheme}-${viewport.width}.png`});}
   await dialog.getByRole('button',{name:'Done',exact:true}).click();await dialog.waitFor({state:'hidden'});
  }
  assert.deepEqual(operations,[],'opening and navigating the dialog never changes settings');
  await toggle.click();await dialog.getByRole('button',{name:'Open in ChatGPT',exact:true}).click();
  assert.equal(operations.at(-1)[0],`/api/chats/${id}/automation/reveal`);
  await dialog.getByRole('button',{name:'Retry failed action',exact:true}).click();
  await dialog.getByRole('button',{name:'Cancel queued action',exact:true}).waitFor();
  assert.equal(operations.at(-1)[0],`/api/chats/${id}/automation/action/retry`);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
