import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {chromium,type BrowserContext,type Page} from "patchright";
import {fingerprintAccountIdentity} from "../src/account";
import {approveConversationCard} from "../src/conversation-approval";
import {ChatGptBrowserDriver,type SingleBrowserSurface} from "../src/chatgpt-driver";
import {SingleWindowCoordinator} from "../src/browser-window";
import {privateChromeExecutable} from "../src/chrome-executable";
import {protocolBuild,type ConversationApprovalRequest} from "../src/protocol";

const native=process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME==="1";
const url="https://chatgpt.com/c/approval-fixture",name="Fixtüre 工具",appId="asdk_app_approval_fixture";
const build=protocolBuild("approval-test");
const request:ConversationApprovalRequest={url,connectorName:name,expectedAccountFingerprint:fingerprintAccountIdentity("fixture-user","fixture-account")};
let context:BrowserContext,page:Page,profile:string,body="",accountRequests=0;
let accountChangesAt=Infinity;
const surface:SingleBrowserSurface={page:async()=>page,navigate:async destination=>{await page.goto(destination);return page;},reveal:async()=>{},beginAction:async()=>{},endAction:async()=>{},close:async()=>{}};

function fixture(options:{once?:string;conversation?:string;header?:string;extra?:boolean;reverse?:boolean;disabled?:boolean;changeSource?:boolean;changeUrl?:boolean;preexistingMenu?:boolean;owned?:boolean;persists?:boolean}={}) {
  accountRequests=0;accountChangesAt=Infinity;
  const rows=[options.once??"Allow once",options.conversation??`Allow ${name} for this conversation`];
  if(options.reverse)rows.reverse();if(options.extra)rows.push("Another permission");
  body=`<div data-turn-key="approval-turn"><div data-user-message-bubble><span data-prompt-link-href="app://${appId}">${name}</span></div>
   <div data-codex-approval-surface="true"><div><div role="alert"><div class="flex"><div class="text-secondary"><span class="wrap-anywhere">${options.header??name}</span></div><div>Permission requested</div><button type="button" aria-haspopup="dialog">Details</button></div></div></div>
    <form><div><button type="button" class="bg-primary-soft-alpha" id="deny">Deny</button><div>
     <button type="button" class="bg-primary-solid" id="once">Allow once</button><button type="button" class="bg-primary-solid" id="random-trigger" aria-haspopup="menu" aria-expanded="false">⌄</button>
    </div></div></form>
   </div></div><form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true" style="min-height:24px"></div><button type="submit">Send</button></form>
   ${options.preexistingMenu?'<div role="menu"><div role="menuitem">Existing menu</div></div>':''}
   <script>
    window.clicks={arrow:0,once:0,conversation:0,deny:0,send:0};
    document.body.dataset.clicks=JSON.stringify(window.clicks);
    document.addEventListener('click',()=>{document.body.dataset.clicks=JSON.stringify(window.clicks);});
    document.querySelector('#deny').onclick=()=>window.clicks.deny++;
    document.querySelector('#once').onclick=()=>window.clicks.once++;
    document.querySelector('form[data-chatgpt-composer]').onsubmit=event=>{event.preventDefault();window.clicks.send++;};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelector('[role="menu"]')?.remove();document.querySelector('#random-trigger').setAttribute('aria-expanded','false');}});
    document.querySelector('#random-trigger').onclick=()=>{
     window.clicks.arrow++;document.querySelector('#random-trigger').setAttribute('aria-expanded','true');
     if(${!!options.changeSource})document.querySelector('[role="alert"] .wrap-anywhere').textContent='Another connector';
     if(${!!options.changeUrl})history.replaceState({},'','/c/another-conversation');
     const menu=document.createElement('div');menu.setAttribute('role','menu');
     if(${options.owned!==false})menu.setAttribute('aria-labelledby','random-trigger');
     ${JSON.stringify(rows)}.forEach((label,index)=>{const row=document.createElement('div');row.setAttribute('role','menuitem');row.tabIndex=0;row.textContent=label;
      if(${!!options.disabled}&&index===1)row.setAttribute('aria-disabled','true');
      row.onclick=()=>{if(index===1){window.clicks.conversation++;if(!${!!options.persists})document.querySelector('[data-codex-approval-surface]')?.remove();}else window.clicks.once++;menu.remove();};menu.append(row);});
     document.body.append(menu);
    };
   </script>`;
}

beforeAll(async()=>{
  if(!native)return;
  profile=await mkdtemp(join(tmpdir(),"approval-fixture-"));
  const executablePath=await privateChromeExecutable(join(import.meta.dirname,"../.browsers",`${process.platform}-${process.arch}`));
  context=await chromium.launchPersistentContext(profile,{channel:"chrome",executablePath,headless:true});page=context.pages()[0]!;
  page.on('pageerror',error=>console.error('approval fixture error:',error.message));
  await context.route("https://chatgpt.com/**",async route=>{
    if(new URL(route.request().url()).pathname==="/api/auth/session"){
      accountRequests++;
      await route.fulfill({json:{user:{id:"fixture-user"},account:{id:accountRequests>=accountChangesAt?"changed-account":"fixture-account",planType:"pro",structure:"personal"}}});
    }else await route.fulfill({contentType:"text/html",body:'<!doctype html><meta charset="utf-8">'+body});
  });
},30_000);
afterAll(async()=>{await context?.close();if(profile)await rm(profile,{recursive:true,force:true});});

test.skipIf(!native)("English, Greek and Italian approval menus grant conversation scope without once, deny, Send or navigation",async()=>{
  for(const [once,conversation] of [["Allow once",`Allow ${name} for this conversation`],["Να επιτρέπεται μία φορά",`Να επιτρέπεται το ${name} για αυτήν τη συνομιλία`],["Consenti una volta",`Consenti ${name} per questa conversazione`]]){
    fixture({once,conversation});await surface.navigate(url);
    const coordinator=new SingleWindowCoordinator(new ChatGptBrowserDriver(surface,build),build);
    expect(await coordinator.approvePendingConversation(request)).toMatchObject({approved:true});
    expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!))).toEqual({arrow:1,once:0,conversation:1,deny:0,send:0});
    expect(page.url()).toBe(url);expect(context.pages()).toEqual([page]);
    expect(await coordinator.approvePendingConversation(request)).toMatchObject({approved:false});
    expect((await coordinator.health()).activeActionId).toBeNull();
  }
});

test.skipIf(!native)("the owned opening relationship works when Radix omits menu association attributes",async()=>{
  fixture({owned:false});await surface.navigate(url);
  expect(await approveConversationCard(page,request,appId,new AbortController().signal)).toBeTrue();
});

test.skipIf(!native)("wrong conversation, account, connector, app identity, duplicate cards and existing menus never grant permission",async()=>{
  for(const variant of ["url","account","header","app","duplicate","existing-menu"]){
    fixture({header:variant==="header"?"Another connector":name,preexistingMenu:variant==="existing-menu"});await surface.navigate(url);
    if(variant==="duplicate")await page.locator('[data-codex-approval-surface]').evaluate(card=>card.after(card.cloneNode(true)));
    const input={...request,...(variant==="url"?{url:"https://chatgpt.com/c/other"}:{}),...(variant==="account"?{expectedAccountFingerprint:"wrong-account"}:{})};
    await approveConversationCard(page,input,variant==="app"?"asdk_app_other":appId,new AbortController().signal).catch(()=>false);
    expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!).conversation)).toBe(0);
    expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!).arrow)).toBe(0);
  }
});

test.skipIf(!native)("unexpected choices, disabled options and changed targets are not approved",async()=>{
  for(const options of [{extra:true},{reverse:true},{disabled:true},{changeSource:true},{changeUrl:true},{conversation:"Allow another connector"}]){
    fixture(options);await surface.navigate(url);
    await approveConversationCard(page,request,appId,new AbortController().signal).catch(()=>false);
    expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!))).toMatchObject({conversation:0,once:0,deny:0,send:0});
  }
  fixture();await surface.navigate(url);accountChangesAt=2;
  await approveConversationCard(page,request,appId,new AbortController().signal).catch(()=>false);
  expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!).conversation)).toBe(0);
});

test.skipIf(!native)("a cancelled check and a stuck approval release the browser without submitting messages",async()=>{
  fixture();await surface.navigate(url);
  await approveConversationCard(page,request,appId,AbortSignal.abort()).catch(()=>false);
  expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!).arrow)).toBe(0);
  fixture({persists:true});await surface.navigate(url);
  const coordinator=new SingleWindowCoordinator(new ChatGptBrowserDriver(surface,build),build);
  await coordinator.approvePendingConversation(request).catch(()=>false);
  expect((await coordinator.health()).activeActionId).toBeNull();
  expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!).send)).toBe(0);
});

test.skipIf(!native)("an approval blocking a newly opened target stops ordinary sends before the composer is changed",async()=>{
  fixture();await surface.navigate(url);
  const coordinator=new SingleWindowCoordinator(new ChatGptBrowserDriver(surface,build),build);
  const action={actionId:"blocked-before-send",idempotencyKey:"blocked-before-send",url,expectedUrl:url,pairingGeneration:1,connectorName:name,expectedAccountFingerprint:request.expectedAccountFingerprint,model:"gpt-6-sol",effort:"high",prompt:{kind:"offline_goal" as const,goalRevision:1},autoApproveToolCalls:true};
  await coordinator.execute(action);for await(const _event of coordinator.events(action.actionId,0)){}
  expect(await coordinator.action(action.actionId)).toMatchObject({state:"approval_required",sendAccepted:false});
  expect(await page.locator('#prompt-textarea').textContent()).toBe("");
  expect(await page.evaluate(()=> JSON.parse(document.body.dataset.clicks!).send)).toBe(0);
});
