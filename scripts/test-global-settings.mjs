import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';
import {ownerHtml} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: Pro labels repair old generic catalogs and preserve Astra/Pro selection`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  const id='e'.repeat(64),now=Date.now(),selection={model:'gpt-6-astra',effort:'max'};
  const models=[
   {id:'gpt-6-astra',label:'GPT-6 (Pro)',efforts:[{id:'max',label:'Pro',available:true}]},
   {id:'gpt-6-sol',label:'GPT-6',efforts:[{id:'high',label:'High',available:true}]},
   {id:'gpt-5.6-sol',label:'GPT-5.6 Sol',efforts:[{id:'high',label:'High',available:true}]},
  ];
  const mutations=[];
  await page.route('http://127.0.0.1:43228/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(request.method()!=='GET')mutations.push(path);
   if(path==='/api/global')return route.fulfill({json:{version:'1.7.0',plan:{label:'Pro 20x',kind:'pro'},latest:{updateAvailable:false}}});
   if(path==='/api/chats')return route.fulfill({json:{chats:[{id,title:'Saved Astra chat',workspace:'fixture',lastEntryEnd:0,lastEntryAtMs:now,lastAgentCallAtMs:null,totalToolCalls:0}],serverTimeMs:Date.now()}});
   if(path.endsWith('/automation'))return route.fulfill({json:{enabled:true,pairing:{status:'verified'},goal:null,action:{status:'idle'},selection,catalog:{models},companion:{authenticated:true,status:'idle'},presence:{lastAgentCallAtMs:null},serverTimeMs:Date.now()}});
   if(path==='/api/new-chat'||path.endsWith('/automation/capabilities'))return route.fulfill({json:{models,catalogRevision:'old-generic-catalog'}});
   if(path==='/api/projects')return route.fulfill({json:{catalog:{projects:[],total:0,warnings:[]},createWorktree:true}});
   return route.fulfill({json:{_meta:{['io.github.devnoname120/codexify/markdown-chat']:{chat_file:'/fixture/CHAT.md',revision:'0',messages:[],delivered_through:0,read_through:0,total_tool_calls:0,last_agent_call_at_ms:null,server_time_ms:Date.now(),has_more:false,unchanged:false}}}});
  });
  await page.goto('http://127.0.0.1:43228/#test-token');await page.getByText('Pro 20x',{exact:true}).waitFor();
  await page.locator('.conversation').filter({hasText:'Saved Astra chat'}).click();
  const model=page.locator('#chat-host #automation-model'),effort=page.locator('#chat-host #automation-effort');
  await model.locator('option[value="gpt-6-sol"]').waitFor({state:'attached'});
  assert.deepEqual(await model.locator('option').allTextContents(),['GPT-6 Astra','GPT-6 Sol','GPT-5.6 Sol']);
  assert.equal(await model.inputValue(),'gpt-6-astra');assert.equal(await effort.inputValue(),'max');assert.equal(await effort.locator('option:checked').textContent(),'Pro');
  await page.getByRole('button',{name:'New chat',exact:true}).click();const dialog=page.getByRole('dialog',{name:'New chat'});
  await dialog.locator('#new-chat-model:enabled').waitFor();
  assert.deepEqual(await dialog.getByLabel('ChatGPT model').locator('option').allTextContents(),['GPT-6 Astra','GPT-6 Sol','GPT-5.6 Sol']);
  assert.equal(await dialog.getByLabel('Reasoning effort').inputValue(),'max');
  assert.deepEqual(mutations,['/api/new-chat'],'displaying names must not save a different model or effort');
 }finally{await browser.close();}
});

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: global settings auto-save, validate raw JSON, and wait for restarted health`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);await page.clock.install();
  let version='1.7.0',instance='old',revision=1,healthDown=0,refreshes=0;
  let document={debug:false,workDir:'/workspace',worktrees:{mode:'auto'},agentChat:{enabled:true,automation:{enabled:true}},apiKey:'private-fixture-key'};
  const saves=[],operations=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>({path:'/private/codexify.config.json',document,raw:JSON.stringify(document,null,2),revision:String(revision),defaults:document,restartRequired:false});
  await page.route('http://127.0.0.1:43227/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   assert.equal(request.headers().authorization,'Bearer test-token');
   if(path==='/api/global')return route.fulfill({json:{version,instanceId:instance,plan:{label:'Pro 20x',sourceLabel:'ChatGPT Pro 200',kind:'pro'},latest:{version:'1.8.0',updateAvailable:version==='1.7.0'},settingsAvailable:true,restartAvailable:true}});
   if(path==='/api/chats')return route.fulfill({json:{chats:[],serverTimeMs:Date.now()}});
   if(path==='/api/settings'&&request.method()==='GET')return route.fulfill({json:snapshot()});
   if(path==='/api/settings') {
    const body=request.postDataJSON();saves.push(body);
    if(body.revision!==String(revision))return route.fulfill({status:409,body:'Configuration changed on disk'});
    if(body.raw!=null){try{const parsed=JSON.parse(body.raw);if(typeof parsed.debug!=='boolean')throw Error('debug must be boolean');document=parsed;}catch(error){return route.fulfill({status:400,body:error.message});}}
    else for(const [key,value] of Object.entries(body.changes)){const parts=key.split('.');let target=document;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;}
    revision++;return route.fulfill({json:{...snapshot(),restartRequired:true}});
   }
   if(path==='/api/settings/restart'||path==='/api/settings/update'){operations.push(path);healthDown=2;if(path.endsWith('/update'))version='1.8.0';return route.fulfill({json:path.endsWith('/update')?{status:'scheduled',targetVersion:'1.8.0',updateId:'update-fixture'}:{scheduled:true}});}
   if(path==='/api/health'){if(healthDown-->0)return route.fulfill({status:503});instance='new';return route.fulfill({json:{status:'ok',tunnelsConfigured:2,tunnelsReady:2}});}
   if(path==='/api/settings/refresh-connector'){refreshes++;return route.fulfill({json:{phase:'completed',source:'manual',refreshId:'refresh-test',result:{refreshObserved:true,permissionChanged:true,schemaVerified:false}}});}
   return route.fulfill({status:404});
  });
  await page.goto('http://127.0.0.1:43227/#test-token');
  await page.getByText('Pro 20x',{exact:true}).waitFor();
  assert.equal(await page.getByText('Search names and conversation content. Use Rename chat to save a name.').count(),0);
  assert.equal(await page.locator('#global-version').textContent(),'v1.7.0');await page.locator('#global-update').waitFor();
  await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Codexify settings'});
  await dialog.getByRole('button',{name:'Advanced',exact:true}).click();await dialog.getByRole('group',{name:'debug',exact:true}).getByRole('button',{name:'On',exact:true}).click();await page.clock.fastForward(700);
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  assert.equal(document.debug,true);assert.deepEqual(saves[0].changes,{debug:true});assert.equal(document.apiKey,'private-fixture-key');
  await dialog.getByRole('button',{name:'Connections',exact:true}).click();
  assert.equal(await dialog.getByLabel('apiKey',{exact:true}).getAttribute('type'),'password');
  await dialog.getByRole('button',{name:'View raw config',exact:true}).click();
  const raw=dialog.getByLabel('Raw configuration JSON');await raw.fill('{');
  await dialog.getByRole('button',{name:'Save raw config',exact:true}).click();await dialog.locator('#settings-save-state[data-error=true]').waitFor();assert.equal(document.debug,true);
  await raw.fill(JSON.stringify({...document,debug:false}));await dialog.getByText('Raw configuration changes are not saved yet.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Restart Codexify',exact:true}).click();await dialog.getByText('Save raw configuration changes before continuing.',{exact:true}).waitFor();assert.equal(operations.length,0);
  await dialog.getByRole('button',{name:'Save raw config',exact:true}).click();
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();assert.equal(document.debug,false);
  await dialog.getByRole('button',{name:'Restart Codexify',exact:true}).click();
  await page.clock.fastForward(6000);await dialog.getByText('Codexify restarted.',{exact:true}).waitFor();assert.equal(operations[0],'/api/settings/restart');
  await dialog.getByRole('button',{name:'Update Codexify',exact:true}).click();await page.clock.fastForward(6000);
  await page.getByText('v1.8.0',{exact:true}).waitFor();assert.equal(await page.locator('#global-update').isVisible(),false);
  await dialog.getByRole('button',{name:'Refresh connector',exact:true}).click();await dialog.getByText('Connector refresh completed; Allow all tools is selected.',{exact:true}).waitFor();assert.equal(refreshes,1);
  await page.setViewportSize({width:375,height:850});const box=await dialog.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=375);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: settings categories, search, inherited values, and complex editors stay usable`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);await page.clock.install();
  const defaults={workDir:'/example',multiProject:true,port:3000,debug:false,worktrees:{mode:'auto',keepCount:15},agentChat:{automation:{enabled:false,requestBlockList:[]},notifications:{events:{completed:true,inputRequired:true,errors:true,offline:true}}},mcpServers:{example:{command:'example'}},openaiTunnels:[{tunnelId:'example'}]};
  let document={workDir:'/projects',multiProject:true,port:3000,worktrees:{mode:'always',keepCount:5},agentChat:{automation:{enabled:true,requestBlockList:[]}},mcpServers:{local:{command:'fixture-tools'}},openaiTunnels:[]},revision=1;
  const writes=[],errors=[];let failSave=false,heldSave=null;
  page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>({path:'/fixture/config.json',document,defaults,revision:String(revision),raw:JSON.stringify(document,null,2)});
  await page.route('http://127.0.0.1:43229/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(path==='/api/global')return route.fulfill({json:{version:'1.7.0',plan:{label:'Pro 20x'},settingsAvailable:true,restartAvailable:true,latest:{updateAvailable:false}}});
   if(path==='/api/chats')return route.fulfill({json:{chats:[]}});
   if(path==='/api/settings'&&request.method()==='GET')return route.fulfill({json:snapshot()});
   if(path==='/api/settings'){
    const body=request.postDataJSON();writes.push(body);
    if(failSave)return route.fulfill({status:409,body:'Configuration changed on disk; reload it before saving'});
    if(heldSave)await heldSave;
    assert.equal(body.revision,String(revision));
    if(body.raw!=null)document=JSON.parse(body.raw);
    else for(const [key,value] of Object.entries(body.changes)){const parts=key.split('.');let target=document;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;}
    revision++;return route.fulfill({json:{...snapshot(),restartRequired:true}});
   }
   throw Error(`Unexpected request: ${path}`);
  });
  await page.goto('http://127.0.0.1:43229/#test-token');await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Codexify settings'});
  await dialog.getByLabel('workDir',{exact:true}).waitFor();
  assert.equal(await dialog.locator('.settings-card').count(),1);
  assert.equal(await dialog.locator('#settings-nav button[aria-current=true]').textContent(),'General');
  const inputStyle=await dialog.getByLabel('workDir',{exact:true}).evaluate(input=>({border:getComputedStyle(input).borderTopWidth,background:getComputedStyle(input).backgroundColor}));
  assert.equal(inputStyle.border,'1px');assert.notEqual(inputStyle.background,'rgba(0, 0, 0, 0)');
  await dialog.getByRole('button',{name:'Workspaces',exact:true}).click();
  await dialog.getByLabel('worktrees.mode',{exact:true}).selectOption('');await page.clock.fastForward(700);
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  assert.equal(Object.hasOwn(document.worktrees,'mode'),false,'Default removes the override rather than writing invalid null');
  assert.equal(document.worktrees.keepCount,5);assert.equal(document.mcpServers.local.command,'fixture-tools');assert.equal(typeof writes[0].raw,'string');
  await dialog.getByRole('button',{name:'Notifications',exact:true}).click();
  assert.equal(await dialog.getByRole('group',{name:'agentChat.notifications.events.completed',exact:true}).getByRole('button',{name:'On (default)',exact:true}).getAttribute('aria-pressed'),'true');
  await dialog.getByRole('group',{name:'agentChat.notifications.events.completed',exact:true}).getByRole('button',{name:'Off',exact:true}).click();
  await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();assert.equal(document.agentChat.notifications.events.completed,false);
  await dialog.getByLabel('Search settings',{exact:true}).fill('blocked requests');
  assert.equal(await dialog.locator('[data-setting-row]').count(),1);
  const blocked=dialog.getByLabel('agentChat.automation.requestBlockList',{exact:true});
  const patterns=['^https?://(www\\.)?chatgpt\\.com/.*/rgstr','^https?://(www\\.)?chatgpt\\.com/backend-api/conversations'];
  await blocked.fill(patterns.join('\n'));await dialog.getByRole('button',{name:'General',exact:true}).click();await page.clock.fastForward(700);
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();assert.deepEqual(document.agentChat.automation.requestBlockList,patterns);
  await dialog.getByRole('button',{name:'Connections',exact:true}).click();
  const mcp=dialog.locator('[data-setting-row="mcpServers"]');assert.equal(await mcp.getByLabel('mcpServers',{exact:true}).isVisible(),false);
  const tunnels=dialog.locator('[data-setting-row="openaiTunnels"]');assert.equal(await tunnels.getByLabel('openaiTunnels',{exact:true}).evaluate(input=>input.tagName),'TEXTAREA');assert.equal(await tunnels.getByLabel('openaiTunnels',{exact:true}).isVisible(),false);
  await mcp.getByRole('button',{name:'Edit configuration'}).click();await mcp.getByLabel('mcpServers',{exact:true}).fill('{broken');
  await dialog.getByRole('button',{name:'Restart Codexify',exact:true}).click();await dialog.getByText('Fix the highlighted settings before restarting.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'General',exact:true}).click();await dialog.getByRole('button',{name:'Connections',exact:true}).click();
  await mcp.getByRole('button',{name:'Edit configuration'}).click();assert.equal(await mcp.getByLabel('mcpServers',{exact:true}).inputValue(),'{broken','Invalid edits survive navigation');
  await mcp.getByLabel('mcpServers',{exact:true}).fill('{"local":{"command":"fixture-tools"}}');await page.clock.fastForward(700);
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  // Navigation while a save is still pending must retain the visible draft.
  await dialog.getByRole('button',{name:'General',exact:true}).click();let release;heldSave=new Promise(resolve=>{release=resolve;});
  await dialog.getByLabel('workDir',{exact:true}).fill('/new-projects');await page.clock.fastForward(700);
  await dialog.getByRole('button',{name:'Workspaces',exact:true}).click();await dialog.getByRole('button',{name:'General',exact:true}).click();
  assert.equal(await dialog.getByLabel('workDir',{exact:true}).inputValue(),'/new-projects');release();heldSave=null;
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();assert.equal(document.workDir,'/new-projects');
  // Header/footer remain fixed when the content scrolls. The form fits phones.
  await dialog.getByLabel('Search settings',{exact:true}).fill('');await dialog.getByRole('button',{name:'Notifications',exact:true}).click();
  const before=await dialog.locator('#settings-toolbar').boundingBox();await dialog.locator('#settings-main').evaluate(element=>element.scrollTop=1000);
  assert.deepEqual(await dialog.locator('#settings-toolbar').boundingBox(),before);
  for(const colorScheme of ['light','dark']){await page.emulateMedia({colorScheme});await page.setViewportSize({width:375,height:650});
   const overflow=await dialog.evaluate(element=>({dialog:element.scrollWidth>element.clientWidth,content:element.querySelector('#settings-main').scrollWidth>element.querySelector('#settings-main').clientWidth}));assert.deepEqual(overflow,{dialog:false,content:false});
   const footer=await dialog.locator('.settings-footer').boundingBox();assert(footer&&footer.y>=0&&footer.y+footer.height<=650);
  }
  await page.setViewportSize({width:1280,height:900});await dialog.getByRole('button',{name:'Advanced',exact:true}).click();failSave=true;
  await dialog.getByRole('group',{name:'debug',exact:true}).getByRole('button',{name:'On',exact:true}).click();await page.clock.fastForward(700);
  await dialog.getByText('Configuration changed on disk; reload it before saving',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'General',exact:true}).click();await dialog.getByRole('button',{name:'Advanced',exact:true}).click();
  assert.equal(await dialog.getByRole('group',{name:'debug',exact:true}).getByRole('button',{name:'On',exact:true}).getAttribute('aria-pressed'),'true','Failed saves retain the edit');
  failSave=false;await dialog.getByRole('button',{name:'Reload settings',exact:true}).click();await dialog.getByText('All changes saved.',{exact:true}).waitFor();assert.equal(await dialog.getByRole('group',{name:'debug',exact:true}).getByRole('button',{name:'Off (default)',exact:true}).getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: real defaults are muted hints and only edited overrides are saved`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);await page.clock.install();
  const defaults={workDir:null,debug:false,multiProject:false,exec:{defaultShell:'/bin/zsh',idleTimeoutMs:300000,maxSessions:8},filesystem:{maxConcurrentWorkers:4,maxLineBytes:1048576,maxPendingRequests:16},worktrees:{mode:'auto'},tree:{ignore:['node_modules','.git']},mcpServers:{},openaiTunnels:[]};
  const fieldSchema={...defaults,multiProject:true,exec:{defaultShell:null,idleTimeoutMs:999,maxSessions:999},mcpServers:{example:{command:'example'}},openaiTunnels:[{tunnelId:'example'}]};
  let document={workDir:'/projects'},revision=1;
  const writes=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>({path:'/fixture/config.json',document,defaults,fieldSchema,revision:String(revision),raw:JSON.stringify(document)});
  await page.route('http://127.0.0.1:43230/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(path==='/api/global')return route.fulfill({json:{version:'1.7.0',settingsAvailable:true,latest:{updateAvailable:false}}});
   if(path==='/api/chats')return route.fulfill({json:{chats:[]}});
   if(path==='/api/settings'&&request.method()==='GET')return route.fulfill({json:snapshot()});
   if(path==='/api/settings'){
    const body=request.postDataJSON();writes.push(body);assert.equal(body.revision,String(revision));
    if(body.raw!=null)document=JSON.parse(body.raw);
    else for(const [key,value] of Object.entries(body.changes)){const parts=key.split('.');let target=document;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;}
    revision++;return route.fulfill({json:{...snapshot(),restartRequired:true}});
   }
   throw Error(`Unexpected request: ${path}`);
  });
  await page.goto('http://127.0.0.1:43230/#test-token');await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Codexify settings'});
  const inheritedBoolean=dialog.getByRole('group',{name:'multiProject',exact:true}).getByRole('button',{name:'Off (default)',exact:true});
  await inheritedBoolean.waitFor();assert.equal(await inheritedBoolean.getAttribute('aria-pressed'),'true');await inheritedBoolean.click();
  await dialog.getByRole('button',{name:'Tools & files',exact:true}).click();
  for(const [path,text] of Object.entries({'exec.defaultShell':'/bin/zsh (default)','exec.idleTimeoutMs':'300000 (default)','exec.maxSessions':'8 (default)','filesystem.maxConcurrentWorkers':'4 (default)','filesystem.maxLineBytes':'1048576 (default)','filesystem.maxPendingRequests':'16 (default)'})){
   const input=dialog.getByLabel(path,{exact:true});assert.equal(await input.inputValue(),'');assert.equal(await input.getAttribute('placeholder'),text);
   await input.focus();await input.blur();
  }
  await dialog.getByRole('button',{name:'Workspaces',exact:true}).click();
  const mode=dialog.getByLabel('worktrees.mode',{exact:true});assert.equal(await mode.locator('option:checked').textContent(),'Automatic (default)');
  assert.equal(await mode.evaluate(input=>getComputedStyle(input).color),await dialog.locator('#settings-content-description').evaluate(input=>getComputedStyle(input).color));
  await mode.selectOption('');
  await dialog.getByRole('button',{name:'Connections',exact:true}).click();
  const mcp=dialog.locator('[data-setting-row="mcpServers"]');assert.equal(await mcp.locator('.setting-object-summary span').textContent(),'{} (default)');
  await mcp.getByRole('button',{name:'Edit configuration'}).click();assert.equal(await mcp.getByLabel('mcpServers',{exact:true}).getAttribute('placeholder'),'{} (default)');
  await page.clock.fastForward(700);assert.deepEqual(writes,[]);assert.deepEqual(document,{workDir:'/projects'});
  await dialog.getByRole('button',{name:'Tools & files',exact:true}).click();
  // Entering the displayed default is an explicit edit; unrelated hints stay absent.
  const sessions=dialog.getByLabel('exec.maxSessions',{exact:true});await sessions.fill('8');await page.clock.fastForward(700);
  await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  assert.deepEqual(writes[0].changes,{'exec.maxSessions':8});assert.deepEqual(document,{workDir:'/projects',exec:{maxSessions:8}});
  assert.equal(await sessions.getAttribute('data-default'),'false');assert.equal(await sessions.getAttribute('placeholder'),'');
  await sessions.fill('12');await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();assert.equal(document.exec.maxSessions,12);
  await sessions.fill('');await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  assert.deepEqual(document.exec,{});assert.equal(await sessions.getAttribute('placeholder'),'8 (default)');
  await dialog.getByLabel('tree.ignore',{exact:true}).fill('custom');await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  await dialog.getByLabel('tree.ignore',{exact:true}).fill('');await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
  assert.deepEqual(document.tree.ignore,[]);assert.equal(await dialog.getByLabel('tree.ignore',{exact:true}).getAttribute('placeholder'),'');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: connector refresh queues once and survives closing settings`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);await page.clock.install();
  let refresh=null,submissions=0,holdGlobal=false,oldReadStarted,releaseOldRead;
  const oldRead=new Promise(resolve=>{oldReadStarted=resolve;});
  const oldReadGate=new Promise(resolve=>{releaseOldRead=resolve;});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://127.0.0.1:43231/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(path==='/api/chats')return route.fulfill({json:{chats:[]}});
   if(path==='/api/global'){
    const response={version:'1.7.0',settingsAvailable:true,restartAvailable:true,latest:{updateAvailable:false},connectorRefresh:refresh&&{...refresh}};
    if(holdGlobal){holdGlobal=false;oldReadStarted();await oldReadGate;}
    return route.fulfill({json:response});
   }
   if(path==='/api/settings')return route.fulfill({json:{document:{workDir:'/projects'},defaults:{workDir:null},revision:'1',path:'/fixture/config.json',raw:'{"workDir":"/projects"}'}});
   if(path==='/api/settings/refresh-connector'){
    submissions++;refresh={refreshId:`refresh-${submissions}`,source:'manual',phase:'queued'};
    return route.fulfill({json:refresh});
   }
   throw Error(`Unexpected request: ${path}`);
  });
  await page.goto('http://127.0.0.1:43231/#test-token');await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Codexify settings'});await dialog.getByLabel('workDir',{exact:true}).waitFor();
  // An older status response must not erase the newly queued job.
  holdGlobal=true;await page.clock.fastForward(15000);await oldRead;
  const button=dialog.locator('#settings-refresh-connector');await button.click();
  await dialog.getByText('Connector refresh queued. Waiting for browser access.',{exact:true}).waitFor();
  assert.equal(await button.textContent(),'Queued…');assert.equal(await button.isDisabled(),true);
  releaseOldRead();await page.clock.fastForward(100);
  assert.equal(await button.textContent(),'Queued…');await button.dispatchEvent('click');assert.equal(submissions,1);
  refresh={...refresh,phase:'running'};await page.clock.fastForward(3100);
  await dialog.getByText('Refreshing connector tools…',{exact:true}).waitFor();assert.equal(await button.textContent(),'Refreshing…');assert.equal(await button.isDisabled(),true);
  await dialog.getByRole('button',{name:'Close settings',exact:true}).click();
  refresh={...refresh,phase:'completed',result:{refreshObserved:true}};await page.clock.fastForward(3100);
  await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  await dialog.getByText('Connector refresh completed; Allow all tools is selected.',{exact:true}).waitFor();assert.equal(await button.textContent(),'Refresh connector');assert.equal(await button.isDisabled(),false);assert.equal(submissions,1);
  await button.click();await dialog.getByText('Connector refresh queued. Waiting for browser access.',{exact:true}).waitFor();assert.equal(submissions,2);
  refresh={...refresh,phase:'failed',result:{error:'Connector settings changed.'}};await page.clock.fastForward(3100);
  await dialog.getByText('Connector settings changed.',{exact:true}).waitFor();assert.equal(await dialog.locator('#settings-save-state').getAttribute('data-error'),'true');assert.equal(await button.isDisabled(),false);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

for(const [engineName,engine] of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: annotation overrides support inherited hints, true and false without saving untouched defaults`,{timeout:30000},async()=>{
 const browser=await engine.launch();
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);await page.clock.install();
  const keys=['forceDestructiveToolAnnotations','forceIdempotentToolAnnotations','forceOpenWorldToolAnnotations'];
  const hints=Object.fromEntries(keys.map(key=>[key,null]));
  let document={workDir:'/fixture',experimental:{forceReadOnlyToolAnnotations:true}},revision=1;
  const writes=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>({document,raw:JSON.stringify(document,null,2),revision:String(revision),defaults:{experimental:{forceReadOnlyToolAnnotations:false,...hints}},fieldSchema:{experimental:{forceReadOnlyToolAnnotations:false,...hints}},defaultLabels:Object.fromEntries(keys.map(key=>['experimental.'+key,'Keep tool hints']))});
  await page.route('http://127.0.0.1:43240/**',route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   assert.equal(request.headers().authorization,'Bearer test-token');
   if(path==='/api/chats')return route.fulfill({json:{chats:[]}});
   if(path==='/api/global')return route.fulfill({json:{version:'1.7.0',settingsAvailable:true,restartAvailable:true,latest:{updateAvailable:false}}});
   if(path==='/api/settings'&&request.method()==='GET')return route.fulfill({json:snapshot()});
   if(path==='/api/settings'){
    const body=request.postDataJSON();writes.push(body);assert.equal(body.revision,String(revision));
    if(body.raw!=null)document=JSON.parse(body.raw);
    else for(const [path,value]of Object.entries(body.changes)){const parts=path.split('.');let target=document;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;}
    revision++;return route.fulfill({json:{...snapshot(),restartRequired:true}});
   }
   throw Error('Unexpected request: '+path);
  });
  await page.goto('http://127.0.0.1:43240/#test-token');await page.getByRole('button',{name:'Codexify settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Codexify settings'});await dialog.getByRole('button',{name:'Advanced',exact:true}).click();
  for(const key of keys){const group=dialog.getByRole('group',{name:'experimental.'+key,exact:true});await group.waitFor();assert.equal(await group.getByRole('button',{name:'Keep tool hints (default)',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await group.getByRole('button',{name:'True',exact:true}).count(),1);assert.equal(await group.getByRole('button',{name:'False',exact:true}).count(),1);}
  await page.clock.fastForward(1000);assert.equal(writes.length,0,'opening settings must not materialize three null defaults');
  for(const key of keys){
   const group=()=>dialog.getByRole('group',{name:'experimental.'+key,exact:true});
   for(const [label,value]of [['True',true],['False',false]]){
    await group().getByRole('button',{name:label,exact:true}).click();await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
    assert.equal(document.experimental[key],value);assert.equal(document.experimental.forceReadOnlyToolAnnotations,true);
    assert.equal(await group().getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');
   }
   await group().getByRole('button',{name:'Keep tool hints (default)',exact:true}).click();await page.clock.fastForward(700);await dialog.getByText('Saved. Restart Codexify to apply changes.',{exact:true}).waitFor();
   assert.equal(Object.hasOwn(document.experimental,key),false,'reset removes just the override');
   assert.equal(await group().getByRole('button',{name:'Keep tool hints (default)',exact:true}).getAttribute('aria-pressed'),'true');
  }
  assert.deepEqual(document.experimental,{forceReadOnlyToolAnnotations:true});assert.equal(writes.length,9);
  for(const width of [1280,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
   assert.equal(await dialog.evaluate(element=>element.scrollWidth>element.clientWidth),false);
   for(const key of keys)assert.equal(await dialog.getByRole('group',{name:'experimental.'+key,exact:true}).evaluate(element=>element.scrollWidth>element.clientWidth),false);
   if(process.env.CODEXIFY_SETTINGS_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_SETTINGS_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_SETTINGS_SCREENSHOTS}/${engineName.toLowerCase()}-${width}-${theme}-annotations.png`,fullPage:true});}
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
