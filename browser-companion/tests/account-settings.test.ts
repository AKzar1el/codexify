import {expect,spyOn,test} from "bun:test";
import {classifyPlan,readBillingPlan,refreshConnectorTools} from "../src/account-settings";
import {chromium} from "patchright";
import {join} from "node:path";
import {privateChromeExecutable} from "../src/chrome-executable";
import {ChatGptBrowserDriver} from "../src/chatgpt-driver";
import {protocolBuild} from "../src/protocol";
import {modelsFromDiscoveredEfforts} from "../src/models";
import {chatGptModelSelectionMatches} from "../src/model-selection";
import {SingleWindowCoordinator} from "../src/browser-window";

test("billing aliases preserve unknown plans instead of calling them Free",()=>{
 for(const [source,label,kind] of [
  ["ChatGPT Free","Free","free"],["Go","Go","go"],["ChatGPT Pro 50","Pro 5x","pro"],
  ["ChatGPT Pro 200","Pro 20x","pro"],["ChatGPT Pro 250","Pro 25x","pro"],["Pro 25x","Pro 25x","pro"],
  ["ChatGPT Business","ChatGPT Business","unknown"],["ChatGPT Pro 300","ChatGPT Pro 300","pro"]
 ]){const plan=classifyPlan(source!);expect(plan.label).toBe(label!);expect(plan.kind).toBe(kind as any);}
 expect(classifyPlan("")).toEqual({label:"",sourceLabel:"",kind:"unknown"});
});
test("model display names come from the picker when it names the family",()=>{
 const efforts=[{id:"low",label:"Instant",index:0,available:true,reason:null}];
 expect(modelsFromDiscoveredEfforts("5.6",efforts,"GPT-5.6 Luna")[0]!.label).toBe("GPT-5.6 Luna");
 expect(modelsFromDiscoveredEfforts("5.6",efforts,"GPT-5.6 Sol")[0]!.label).toBe("GPT-5.6 Sol");
 expect(modelsFromDiscoveredEfforts("5.6",efforts)[0]!.label).toBe("GPT-5.6");
 expect(chatGptModelSelectionMatches(["5.6 Luna Instant, 1 of 2"],"5.6","low",true,"GPT-5.6 Luna")).toBeTrue();
});

async function expectFailure(promise:Promise<unknown>,message:string):Promise<void> {
 let failure:unknown;
 try {await promise;}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain(message);
}

test.skipIf(process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME!=="1")("plan checks and localized connector refresh reuse one tab, restore it, and defer while busy",async()=>{
 const executablePath=await privateChromeExecutable(join(import.meta.dirname,'../.browsers',`${process.platform}-${process.arch}`));
 const browser=await chromium.launch({executablePath,headless:true});
 try {
  const context=await browser.newContext();const page=await context.newPage();let permission='read_only',refreshes=0,deletes=0,billingReads=0,failConnector=false,fastRefresh=false,replaceRefresh=false,refreshDelay=300,permissionVisits=0;const visits:string[]=[];
  let releaseBilling:(()=>void)|undefined,billingEntered:(()=>void)|undefined,holdBilling:Promise<void>|undefined;
  let planAccount='fixture-account',permissionLabel='Permiso',allowLabel='Permitir todo';
  const witness:{summary?:string;remember:(summary:string)=>void}={remember:summary=>witness.summary=summary};
  await page.context().route('https://chatgpt.com/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(route.request().isNavigationRequest())visits.push(path);
   if(path==='/api/auth/session')return route.fulfill({json:{user:{id:'fixture-user'},account:{id:new URL(route.request().frame().page().url()).pathname==='/settings/billing'?planAccount:'fixture-account',planType:'pro',structure:'personal'}}});
   if(path==='/settings/billing'){billingReads++;billingEntered?.();if(holdBilling)await holdBilling;return route.fulfill({contentType:'text/html',body:'<h2>ChatGPT Pro 200</h2>'});}
   if(path==='/c/original')return route.fulfill({contentType:'text/html',body:'<form><div id="prompt-textarea" contenteditable="true"></div></form>'});
   if(path==='/set-permission'){permission='allow_all';return route.fulfill({json:{ok:true}});}
   if(path==='/refresh'){refreshes++;return route.fulfill({json:{ok:true}});}
   if(path==='/delete'){deletes++;return route.fulfill({json:{ok:true}});}
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<form><div id="prompt-textarea" contenteditable="true"><span app-mention-path="app://'+(failConnector?'invalid':'asdk_app_fixture')+'" app-mention-display-name="Fixture connector" contenteditable="false">Fixture connector</span></div></form>'});
   if(path.endsWith('/permissions')){permissionVisits++;return route.fulfill({contentType:'text/html',body:`<h2>Permissions</h2>${['Preguntar','Solo lectura','Bajo riesgo','Permitir todo'].map((label,index)=>`<div role="radio" tabindex="0" aria-checked="${permission==='allow_all'?index===3:index===1}" data-index="${index}">${label}</div>`).join('')}<script>document.querySelectorAll('[role=radio]').forEach(node=>node.onclick=async()=>{await fetch('/set-permission',{method:'POST'});document.querySelectorAll('[role=radio]').forEach(item=>item.setAttribute('aria-checked',String(item===node)));});</script>`});}
   return route.fulfill({contentType:'text/html',body:`<section id="plugin-settings"><div hidden>Fixture connector</div><h2>Fixture connector</h2><button>Detalles</button><button style="color:rgb(255,0,0)">Quitar</button><section id="settings-cards"><div role="button" id="permission"><svg width="16" height="16"><path d="M1 1L10 10"/></svg><span>${permissionLabel}</span><span>Elegir permisos</span><span>${permission==='allow_all'?allowLabel:'Solo lectura'}</span></div><div id="choices" hidden>${['Preguntar','Solo lectura','Bajo riesgo','Permitir todo'].map((label,index)=>`<div role="radio" tabindex="0" aria-checked="${permission==='allow_all'?index===3:index===1}" data-index="${index}">${label}</div>`).join('')}</div><section id="manage"><div><span>Nombre</span><button>Editar nombre</button></div><div><span>Descripción</span><button>Editar descripción</button></div><div><span>Actualizar herramientas</span><button id="refresh">Actualizar herramientas</button></div><div><span>Eliminar</span><button style="color:rgb(255,0,0)" onclick="fetch('/delete',{method:'POST'})">Eliminar</button></div></section></section></section><script>document.getElementById('permission').onclick=()=>document.getElementById('choices').hidden=false;document.querySelectorAll('[role=radio]').forEach(node=>node.onclick=async()=>{await fetch('/set-permission',{method:'POST'});document.querySelectorAll('[role=radio]').forEach(item=>item.setAttribute('aria-checked',String(item===node)));document.getElementById('permission').textContent='Allow all';});document.getElementById('refresh').onclick=async function(){this.disabled=true;await fetch('/refresh',{method:'POST'});${replaceRefresh?'const fresh=this.cloneNode(true);fresh.disabled=false;fresh.removeAttribute("data-refresh-tools-target");this.replaceWith(fresh);':fastRefresh?'this.disabled=false;':`setTimeout(()=>this.disabled=false,${refreshDelay});`}};</script>`});
  });
  const plan=await readBillingPlan(page);expect(plan.label).toBe('Pro 20x');
  const result=await refreshConnectorTools(page,'Fixture connector',undefined,undefined,undefined,witness);expect(result.refreshObserved).toBeTrue();expect(result.permissionChanged).toBeTrue();expect(result.schemaVerified).toBeFalse();
  expect(permission).toBe('allow_all');expect(refreshes).toBe(1);expect(deletes).toBe(0);
  const beforePermission=permissionVisits;visits.length=0;
  const again=await refreshConnectorTools(page,'Fixture connector',undefined,undefined,'asdk_app_fixture',witness);expect(again.permissionChanged).toBeFalse();expect(refreshes).toBe(2);expect(deletes).toBe(0);
  expect(permissionVisits).toBe(beforePermission);expect(visits).toEqual([]); // Already on the verified settings page.
  fastRefresh=true;replaceRefresh=true;await page.reload();await refreshConnectorTools(page,'Fixture connector',undefined,undefined,'asdk_app_fixture',witness);fastRefresh=false;replaceRefresh=false;expect(refreshes).toBe(3);
  await page.goto('https://chatgpt.com/c/original');
  let owned=false,beginCalls=0,endCalls=0;
  const driver=new ChatGptBrowserDriver({page:async()=>page,navigate:async url=>{await page.goto(url);return page;},reveal:async()=>{},beginAction:async()=>{if(owned)throw Error('busy');owned=true;beginCalls++;},endAction:async()=>{owned=false;endCalls++;},close:async()=>{}},protocolBuild('settings-test'));
  const original=page.url(),initialPages=context.pages();
  const newPage=spyOn(context,'newPage').mockImplementation(async()=>{throw Error('Maintenance must never create a tab');});
  let addedPages=0;context.on('page',()=>addedPages++);
  try {
    const before=billingReads;
    await driver.accountPlan('startup-one');expect(page.url()).toBe(original);
    await driver.accountPlan('startup-one');expect(billingReads-before).toBe(1);
    await driver.accountPlan('startup-two');expect(billingReads-before).toBe(2);expect(page.url()).toBe(original);
    await driver.refreshConnector('Fixture connector');expect(page.url()).toBe(original);expect(refreshes).toBe(4);
    const permissionBeforeCached=permissionVisits;visits.length=0;
    await driver.refreshConnector('Fixture connector');expect(visits).toEqual(['/settings/plugins-settings/plugin_asdk_app_fixture','/c/original']);
    expect(permissionVisits).toBe(permissionBeforeCached);expect(refreshes).toBe(5);
    // Completion waits beyond the UI deadline without retaining browser access.
    const coordinator=new SingleWindowCoordinator(driver,protocolBuild('queued-refresh-test'),{operationMs:1500,cleanupMs:100,hardStopMs:100});
    refreshDelay=2200;
    const pendingRefresh=coordinator.refreshConnector('Fixture connector');
    const duplicate=expectFailure(coordinator.refreshConnector('Fixture connector'),'busy');
    const waitStarted=async()=>{const started=Date.now();while(owned||!await page.evaluate(()=>document.querySelector('#refresh')?.matches(':disabled')===true)){if(Date.now()-started>1500)throw Error('Refresh did not start');await new Promise(resolve=>setTimeout(resolve,20));}};
    await waitStarted();await duplicate;
    await expectFailure(coordinator.refreshConnector('Other connector'),'busy');
    expect(owned).toBeFalse();expect((await coordinator.health()).status).toBe('idle');
    await coordinator.reveal(null); // Another UI transaction finishes while refresh is pending.
    await pendingRefresh;expect(page.url()).toBe(original);
    const interrupted=coordinator.refreshConnector('Fixture connector');
    const failure=expectFailure(interrupted,'another browser action');
    await waitStarted();
    await coordinator.reveal('https://chatgpt.com/c/other');
    await failure;expect(page.url()).toBe('https://chatgpt.com/c/other'); // Never restore over that action.
    await page.goto(original);
    const cancel=new AbortController(),cancelled=coordinator.refreshConnector('Fixture connector',cancel.signal);
    const cancellation=expectFailure(cancelled,'cancelled');await waitStarted();cancel.abort();await cancellation;
    expect(page.url()).toBe(original);expect((await coordinator.health()).status).toBe('idle');refreshDelay=300;
    permissionLabel='Autorisation';allowLabel='Tout autoriser';const beforeLocale=permissionVisits;
    await driver.refreshConnector('Fixture connector');expect(permissionVisits).toBe(beforeLocale+1); // Learn the new locale from checked radio state.
    await driver.refreshConnector('Fixture connector');expect(permissionVisits).toBe(beforeLocale+1); // Then the direct path needs no permissions visit.
    expect(newPage).not.toHaveBeenCalled();expect(addedPages).toBe(0);expect(context.pages()).toEqual(initialPages);expect(page.isClosed()).toBeFalse();
    // Maintenance owns the same tab until the previous URL has been restored.
    holdBilling=new Promise(resolve=>{releaseBilling=resolve;});
    const entered=new Promise<void>(resolve=>{billingEntered=resolve;});
    const pending=driver.accountPlan('startup-three');await entered;
    const health=await driver.health();expect(health.authenticated).toBeTrue();expect(health.status).toBe('busy');
    releaseBilling!();await pending;holdBilling=undefined;billingEntered=undefined;expect(page.url()).toBe(original);
    // Drafts are cleared before maintenance; response/approval UI does not own the browser queue.
    const composer=page.locator('#prompt-textarea');await composer.fill('User draft');const readsBeforeDraft=billingReads;
    {
      const beforeNavigation:string[]=[],originalGoto=page.goto.bind(page),goto=spyOn(page,'goto');
      goto.mockImplementation(async(url,options)=>{
        if(page.url()===original&&url!==original)beforeNavigation.push((await composer.innerText()).trim());
        return originalGoto(url,options);
      });
      try {
        expect((await driver.health()).status).toBe('idle');expect(await composer.innerText()).toBe('User draft');
        await driver.accountPlan('draft');expect(billingReads).toBe(readsBeforeDraft+1);
        await composer.fill('Another draft');await driver.refreshConnector('Fixture connector');
        expect(beforeNavigation.length).toBeGreaterThanOrEqual(2);expect(beforeNavigation.every(text=>text==='')).toBeTrue();
      }finally{goto.mockRestore();}
    }
    expect(await composer.innerText()).toBe('');expect(page.url()).toBe(original);
    await composer.fill('');await page.evaluate(()=>{const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);});
    await driver.accountPlan('running');expect(page.url()).toBe(original);
    await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<button data-testid="stop-button">Stop</button>'));
    await driver.refreshConnector('Fixture connector');expect(page.url()).toBe(original);
    await page.evaluate(()=>{const approval=document.createElement('div');approval.setAttribute('role','dialog');approval.textContent='Allow ChatGPT to use Fixture connector?';document.body.append(approval);});
    await driver.accountPlan('approval');await driver.refreshConnector('Fixture connector');
    expect(page.url()).toBe(original);
    // Failures and account changes also restore the original tab and release it.
    planAccount='other-account';await expectFailure(driver.accountPlan('changed-account'),'account changed');expect(page.url()).toBe(original);planAccount='fixture-account';
    const originalGoto=page.goto.bind(page),goto=spyOn(page,'goto');
    goto.mockImplementation(async(url,options)=>{const result=await originalGoto(url,options);if(url.endsWith('/settings/billing'))throw Error('Billing navigation failed');return result;});
    try {expect((await driver.accountPlan('failed-billing')).label).toBe('');}finally{goto.mockRestore();}
    expect(page.url()).toBe(original);
    failConnector=true;
    const freshDriver=new ChatGptBrowserDriver({page:async()=>page,navigate:async url=>{await page.goto(url);return page;},reveal:async()=>{},beginAction:async()=>{},endAction:async()=>{},close:async()=>{}},protocolBuild('fresh-test'));
    await expectFailure(freshDriver.refreshConnector('Fixture connector'),'App ID');expect(page.url()).toBe(original);
    expect((await driver.health()).status).toBe('idle');
    expect(beginCalls).toBe(endCalls);expect(owned).toBeFalse();expect(newPage).not.toHaveBeenCalled();expect(addedPages).toBe(0);expect(context.pages()).toEqual(initialPages);
  } finally {newPage.mockRestore();}
 }finally{await browser.close();}
},30000);


test.skipIf(process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME!=="1")("billing resolves nested plan text and a missing label within the browser action deadline",async()=>{
 const executablePath=await privateChromeExecutable(join(import.meta.dirname,'../.browsers',`${process.platform}-${process.arch}`));
 const browser=await chromium.launch({executablePath,headless:true});
 try {
  const context=await browser.newContext(),page=await context.newPage();let billing='<p>ChatGPT <strong>Pro 200</strong></p>',visits=0;
  await context.route('https://chatgpt.com/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/auth/session')return route.fulfill({json:{user:{id:'fixture-user'},account:{id:'fixture-account',planType:'pro',structure:'personal'}}});
   if(path==='/settings/billing'){visits++;return route.fulfill({contentType:'text/html',body:billing});}
   return route.fulfill({contentType:'text/html',body:'<form><div id="prompt-textarea" contenteditable="true"></div></form>'});
  });
  await page.goto('https://chatgpt.com/c/original');
  const driver=new ChatGptBrowserDriver({page:async()=>page,navigate:async url=>{await page.goto(url);return page;},reveal:async()=>{},beginAction:async()=>{},endAction:async()=>{},close:async()=>{}},protocolBuild('plan-deadline-test'));
  const coordinator=new SingleWindowCoordinator(driver,protocolBuild('plan-deadline-test'));
  expect((await coordinator.accountPlan('nested')).label).toBe('Pro 20x');
  billing='<h2>Billing</h2><p>Subscription details are loading.</p>';
  const started=Date.now();expect((await coordinator.accountPlan('missing')).label).toBe('');
  expect(Date.now()-started).toBeLessThan(8_000);
  expect(page.url()).toBe('https://chatgpt.com/c/original');expect(context.pages()).toEqual([page]);
  await coordinator.accountPlan('missing');expect(visits).toBe(2);
  expect((await coordinator.health()).authenticated).toBeTrue();
 }finally{await browser.close();}
},20_000);

test.skipIf(process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME!=="1")("account-menu fallback ignores names and language, preserves unknown labels, and caches missing plans",async()=>{
 const executablePath=await privateChromeExecutable(join(import.meta.dirname,'../.browsers',`${process.platform}-${process.arch}`));
 const browser=await chromium.launch({executablePath,headless:true});
 try {
  const context=await browser.newContext(),page=await context.newPage();
  let name='Different account',label='Pro',billing='',testId=true,billingReads=0,menuReads=0;
  const shell=()=>`<style>aside{position:fixed;left:8px;bottom:8px}#account-menu{position:fixed;left:60px;bottom:45px;background:white;padding:16px}#account-row{display:flex;gap:16px}#account-row span{display:block;line-height:24px}</style><form><div id="prompt-textarea" contenteditable="true"></div></form><aside><button ${testId?'data-testid="accounts-profile-button"':''} aria-haspopup="menu" aria-expanded="false" aria-label="メニュー">US</button></aside><div role="menu" id="account-menu" hidden><div role="menuitem" id="account-row"><div>US</div><div><span>${name}</span>${label?`<span>${label}</span>`:''}</div></div><hr role="separator"><div role="menuitem">Personnalisation</div><div role="menuitem">Paramètres</div></div><script>const button=document.querySelector('aside button'),menu=document.querySelector('[role=menu]');button.onclick=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');fetch('/menu-open');};document.onkeydown=event=>{if(event.key==='Escape'){menu.hidden=true;button.setAttribute('aria-expanded','false');}};</script>`;
  await context.route('https://chatgpt.com/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/auth/session')return route.fulfill({json:{user:{id:'fixture-user'},account:{id:'fixture-account',planType:'pro',structure:'personal'}}});
   if(path==='/menu-open'){menuReads++;return route.fulfill({json:{ok:true}});}
   if(path==='/settings/billing'){billingReads++;return route.fulfill({contentType:'text/html',body:billing||'<h2>Billing</h2><p>No subscription label</p>'});}
   return route.fulfill({contentType:'text/html',body:shell()});
  });
  await page.goto('https://chatgpt.com/c/original');
  const newPage=spyOn(context,'newPage');
  try {
   const driver=new ChatGptBrowserDriver({page:async()=>page,navigate:async url=>{await page.goto(url);return page;},reveal:async()=>{},beginAction:async()=>{},endAction:async()=>{},close:async()=>{}},protocolBuild('menu-plan-test'));
   const coordinator=new SingleWindowCoordinator(driver,protocolBuild('menu-plan-test'));
   const check=async(epoch:string,expected:string,kind:string)=>{
    const started=Date.now(),plan=await coordinator.accountPlan(epoch);
    expect(plan.label).toBe(expected);expect(plan.kind).toBe(kind as any);
    expect(Date.now()-started).toBeLessThan(8_000);
    expect(page.url()).toBe('https://chatgpt.com/c/original');
    expect(await page.locator('[role="menu"]').isVisible()).toBeFalse();expect(context.pages()).toEqual([page]);
   };
   await check('pro','Pro','pro');
   const reads={billingReads,menuReads};await check('pro','Pro','pro');expect({billingReads,menuReads}).toEqual(reads);
   name='Pro';label='Go';testId=false;await check('go','Go','go');
   name='Another person';label='Research membership';await check('unknown','Research membership','unknown');
   label='';await check('missing','','unknown');
   const missingReads={billingReads,menuReads};await check('missing','','unknown');expect({billingReads,menuReads}).toEqual(missingReads);
   billing='<h2>ChatGPT Pro 200</h2>';label='Pro';const before=menuReads;
   await check('billing','Pro 20x','pro');expect(menuReads).toBe(before);
   const originalGoto=page.goto.bind(page),goto=spyOn(page,'goto');
   goto.mockImplementation(async(url,options)=>{if(url.endsWith('/settings/billing'))throw Error('Billing navigation failed');return originalGoto(url,options);});
   try {await check('navigation-failed','Pro','pro');}finally{goto.mockRestore();}
   expect(newPage).not.toHaveBeenCalled();
  }finally{newPage.mockRestore();}
 }finally{await browser.close();}
},40_000);
