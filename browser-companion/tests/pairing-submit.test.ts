import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { fingerprintAccountIdentity } from "../src/account";
import { SingleWindowCoordinator, type DriverExecution } from "../src/browser-window";
import { ChatGptBrowserDriver, type SingleBrowserSurface } from "../src/chatgpt-driver";
import { privateChromeExecutable } from "../src/chrome-executable";
import { activeComposer, composerText, uniqueSendButton } from "../src/composer";
import { protocolBuild, renderActionPrompt, type ExecuteActionRequest } from "../src/protocol";

const native = process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME === "1";
const build = protocolBuild("pairing-submit-test");
const url = "https://chatgpt.com/c/pairing-submit-fixture";
const connector = "Fixture connector";
const oldPrompt = renderActionPrompt({kind:"pair_verify",reference:"A".repeat(43)});
const newReference = Buffer.alloc(32,1).toString("base64url");
const request: ExecuteActionRequest = {
  actionId:"pairing-submit",idempotencyKey:"pairing-submit-key",url,expectedUrl:url,
  pairingGeneration:2,connectorName:connector,model:null,effort:null,
  expectedAccountFingerprint:fingerprintAccountIdentity("fixture-user","fixture-account"),
  prompt:{kind:"pair_verify",reference:newReference},autoApproveToolCalls:false,
};
const prompt = renderActionPrompt(request.prompt);
let context: BrowserContext;
let page: Page;
let profile: string;
let initialDraft = "";
let ready = true;
let chipName = connector;
let quietGenerationMs = 0;
let generatingOnLoad = false;
let acceptsStop:boolean|number|"reload" = true;
let documentLoads = 0;
let sessionRequests = 0;
let changedAccountAfterReload = false;
let changedUrlAfterReload = false;
let shiftedEfforts = false;
let hideEffortLabels = false;
let initialModel = {family:"6",value:4,locked:[] as number[]};
const pill = (name: string) => `<span app-mention-path="app://fixture" app-mention-display-name="${name}" contenteditable="false">${name}</span> `;

beforeAll(async () => {
  if (!native) return;
  profile = await mkdtemp(join(tmpdir(),"pairing-submit-fixture-"));
  const executablePath = await privateChromeExecutable(join(import.meta.dirname,"../.browsers",`${process.platform}-${process.arch}`));
  context = await chromium.launchPersistentContext(profile,{channel:"chrome",executablePath,headless:true,viewport:null});
  page = context.pages()[0]!;
  await context.route("https://chatgpt.com/**",async route => {
    if (new URL(route.request().url()).pathname === "/api/auth/session") {
      sessionRequests++;
      await route.fulfill({json:{user:{id:"fixture-user"},account:{id:changedAccountAfterReload&&documentLoads>=3 ? "changed-account" : "fixture-account",planType:"pro",structure:"personal"}}});
      return;
    }
    documentLoads++;
    await route.fulfill({contentType:"text/html",body:`<!doctype html><html><style>[data-model-reasoning-effort-slider]{height:24px;min-width:240px}</style><body>
      <section id="history"></section>
      <form data-chatgpt-composer>
        <div role="textbox" contenteditable="true" style="white-space:pre-wrap;min-height:24px" data-composer-markdown><p>${pill(chipName)}${initialDraft}</p></div>
        <button type="submit" aria-label="Send" disabled>Send</button>
        <button type="button" id="effort" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Pro</button>
        ${generatingOnLoad ? '<button type="button" data-testid="stop-button">Stop</button>' : ''}
      </form>
      <div id="picker" role="menu" hidden>
        <div data-model-picker-view="advanced">
          <button role="menuitemradio" data-family="6" aria-checked="true">GPT-6</button>
          <button role="menuitemradio" data-family="5.6" aria-checked="false">GPT-5.6 Sol</button>
          <button role="menuitemradio" data-family="5.5" aria-checked="false">GPT-5.5</button>
        </div>
        <div id="range" role="menuitem" tabindex="0" aria-describedby="effort-description"></div>
        <span id="effort-description"></span>
      </div>
      <div data-mention-list-scroll-area hidden><button data-list-navigation-item="true" data-highlighted=""><span>${connector}</span></button></div>
      <script>
        if (${changedUrlAfterReload&&documentLoads>=3}) history.replaceState({},'', 'https://chatgpt.com/c/changed-after-reload');
        const editor=document.querySelector('[contenteditable="true"]');
        const form=document.querySelector('form');const send=form.querySelector('button');
        const mentions=document.querySelector('[data-mention-list-scroll-area]');
        window.family=${JSON.stringify(initialModel.family)};
        window.definitions={
          '6':{min:0,value:4,labels:['Instant','Medium','High','Extra High','Pro'],locked:[]},
          '5.6':{min:0,value:4,labels:['Instant','Medium','High','Extra High','Pro'],locked:[]},
          '5.5':{min:7,value:11,labels:${JSON.stringify(shiftedEfforts ? ['Instant','Medium','High','Extra High','Pro'] : ['Turbo','Instant','Medium','High','Pro'])},locked:[]}
        };
        window.definitions[window.family].value=${initialModel.value};
        window.definitions[window.family].locked=${JSON.stringify(initialModel.locked)};
        const control=document.querySelector('#effort'),picker=document.querySelector('#picker'),range=document.querySelector('#range');
        window.renderModel=()=>{
          const model=window.definitions[window.family],index=model.value-model.min;
          range.innerHTML='<div data-model-reasoning-effort-slider><span role="slider" aria-valuemin="'+model.min+'" aria-valuemax="'+(model.min+model.labels.length-1)+'" aria-valuenow="'+model.value+'"></span>'+model.labels.map((label,i)=>'<span data-selected="'+(i===index)+'" data-locked="'+model.locked.includes(i)+'" aria-label="'+(${hideEffortLabels}?'':label)+'"></span>').join('')+'</div>';
          document.querySelector('#effort-description').textContent=window.family+' '+model.labels[index]+', '+(index+1)+' of '+model.labels.length+'.';
          control.textContent=model.labels[index];document.body.dataset.family=window.family;document.body.dataset.effort=model.labels[index];
          document.querySelectorAll('[data-family]').forEach(row=>row.setAttribute('aria-checked',String(row.dataset.family===window.family)));
        };
        control.onclick=()=>{picker.hidden=false;control.setAttribute('aria-expanded','true');};
        document.querySelectorAll('[data-family]').forEach(row=>row.onclick=()=>{document.body.dataset.familyChanges+=(row.dataset.family+",");window.family=row.dataset.family;window.renderModel();});
        range.onkeydown=event=>{
          if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
          event.preventDefault();const model=window.definitions[window.family],step=event.key==='ArrowRight'?1:-1;let next=model.value+step;
          document.body.dataset.effortChanges=String(Number(document.body.dataset.effortChanges||0)+1);
          while(next>=model.min&&next<model.min+model.labels.length&&model.locked.includes(next-model.min))next+=step;
          if(next>=model.min&&next<model.min+model.labels.length)model.value=next;
          window.renderModel();
        };
        document.addEventListener('keydown',event=>{if(event.key==='Escape'){picker.hidden=true;control.setAttribute('aria-expanded','false');}});
        window.renderModel();
        document.body.dataset.effortChanges="0";document.body.dataset.familyChanges="";
        editor.focus();const initialCaret=document.createRange();initialCaret.selectNodeContents(editor);initialCaret.collapse(false);
        window.getSelection().removeAllRanges();window.getSelection().addRange(initialCaret);
        document.body.dataset.sends="0";document.body.dataset.stops="0";document.body.dataset.order="";window.enableSend=${ready};
        form.addEventListener('click',event=>{
          const stop=event.target.closest('[data-testid="stop-button"]');
          if (!stop) return;
          document.body.dataset.stops=String(Number(document.body.dataset.stops)+1);
          document.body.dataset.order+='stop,';
          if (${typeof acceptsStop==="number" ? `Number(document.body.dataset.stops)>=${acceptsStop}` : acceptsStop==="reload" ? documentLoads>=3 : acceptsStop}) setTimeout(()=>{stop.remove();document.body.dataset.order+='stopped,';},200);
        });
        editor.addEventListener('input',()=>{
          mentions.hidden=!editor.textContent.startsWith('@');
          if (!mentions.hidden) return;
          send.disabled=true;
          if (window.enableSend) setTimeout(()=>{
            // History hydration happens after composer insertion, before Send becomes usable.
            document.querySelector('#history').innerHTML='<section data-turn-id-container="old"><article data-turn-id="old" data-testid="conversation-turn-old" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>Old answer</p></div></div><button data-testid="copy-turn-action-button">Copy</button></article></section>';
            send.disabled=false;
          },300);
        });
        editor.addEventListener('keydown',event=>{
          if (event.key==='Enter' && !mentions.hidden) {
            event.preventDefault();editor.innerHTML=${JSON.stringify("<p>"+pill(chipName)+"</p>")};mentions.hidden=true;
            const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);
            const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
          }
        });
        form.addEventListener('submit',event=>{
          event.preventDefault();document.body.dataset.order+='send,';document.body.dataset.sends=String(Number(document.body.dataset.sends)+1);document.body.dataset.sentText=editor.textContent;
          document.body.dataset.sentFamily=window.family;document.body.dataset.sentEffort=document.body.dataset.effort;
          editor.innerHTML='';send.disabled=true;
          document.querySelector('#history').insertAdjacentHTML('beforeend','<section data-turn-key="new"><div data-user-message-bubble>Pair verification</div><div data-content-search-unit-key="new-answer"><div data-conversation-role="assistant"><div class="markdown"></div></div></div></section>');
          if (!location.pathname.includes('/c/')) history.replaceState({},'', 'https://chatgpt.com/c/new-created-fixture');
          const finish=()=>{
            document.querySelector('[data-testid="stop-button"]')?.remove();
            document.querySelector('[data-turn-key="new"] [data-conversation-role="assistant"]').innerHTML='<div class="markdown"><p>Verified.</p></div><button data-testid="copy-turn-action-button">Copy</button>';
          };
          if (${quietGenerationMs}>0) {
            form.insertAdjacentHTML('beforeend','<button type="button" data-testid="stop-button">Stop</button>');
            setTimeout(finish,${quietGenerationMs});
          } else finish();
        });
      </script></body></html>`});
  });
},30_000);

afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile,{recursive:true,force:true});
});

const surface: SingleBrowserSurface = {
  page:async()=>page,
  navigate:async destination=>{await page.goto(destination);return page;},
  reveal:async()=>{},beginAction:async()=>{},endAction:async()=>{},close:async()=>{},
};

async function fixture(draft="",canSend=true,name=connector,quietMs=0,generating=false,stopWorks:boolean|number|"reload"=true,model={family:"6",value:4,locked:[] as number[]}) {
  initialDraft=draft;ready=canSend;chipName=name;quietGenerationMs=quietMs;
  generatingOnLoad=generating;acceptsStop=stopWorks;
  documentLoads=0;sessionRequests=0;changedAccountAfterReload=false;changedUrlAfterReload=false;
  initialModel=model;shiftedEfforts=false;hideEffortLabels=false;
  await surface.navigate(url);
  return new ChatGptBrowserDriver(surface,build);
}

test.skipIf(!native)("pairing waits for enabled Send and binds to the new answer after history hydration",async()=>{
  const driver=await fixture();
  const events: DriverExecution["emit"] extends (event:infer T)=>void ? T[] : never = [];
  await driver.execute({request,renderedPrompt:prompt,signal:new AbortController().signal,emit:event=>events.push(event)});
  expect(await page.evaluate(()=> Number(document.body.dataset.sends))).toBe(1);
  expect(events.some(event=>event.type==="send_accepted")).toBeTrue();
  expect(events.at(-1)).toMatchObject({type:"submission_complete",canonicalUrl:url});
  expect((await driver.health()).status).toBe("idle");
  expect(await page.evaluate(()=>document.body.dataset.sentEffort)).toBe("Medium");
  expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("Pro");
},15_000);

const offlineRequest = (model = "gpt-5.5-sol", effort = "low"): ExecuteActionRequest => ({
  ...request, model, effort, prompt:{kind:"offline_goal",goalRevision:1},
});

test.skipIf(!native)("a cold-cache send navigates before touching models and selects only the destination family",async()=>{
  await fixture();
  await page.goto("https://chatgpt.com/c/unrelated-conversation");
  initialModel={family:"6",value:4,locked:[]};
  let source:unknown;
  const targetSurface={...surface, navigate:async(destination:string)=>{
    source=await page.evaluate(()=>({family:document.body.dataset.family, moves:document.body.dataset.effortChanges, families:document.body.dataset.familyChanges}));
    return surface.navigate(destination);
  }};
  const driver=new ChatGptBrowserDriver(targetSurface,build);
  driver.capabilities=async()=>{throw new Error("A send must not refresh the full catalog");};
  const submitted=offlineRequest();const events:Parameters<DriverExecution['emit']>[0][]=[];
  await driver.execute({request:submitted,renderedPrompt:renderActionPrompt(submitted.prompt),signal:new AbortController().signal,emit:event=>events.push(event)});
  expect(source).toEqual({family:"6",moves:"0",families:""});
  expect(page.url()).toBe(url);
  expect(await page.evaluate(()=>document.body.dataset.familyChanges)).toBe("5.5,");
  expect(await page.evaluate(()=>document.body.dataset.effortChanges)).toBe("3");
  expect(await page.evaluate(()=>[document.body.dataset.sentFamily,document.body.dataset.sentEffort])).toEqual(["5.5","Instant"]);
  expect(events.map(event=>event.type)).toEqual(["navigating","composer_ready","model_verified","connector_verified","send_accepted","submission_complete"]);
},15_000);

test.skipIf(!native)("an already-selected request does not cycle any effort or model options",async()=>{
  const driver=await fixture("",true,connector,0,false,true,{family:"6",value:4,locked:[]});
  driver.capabilities=async()=>{throw new Error("Unexpected catalog refresh");};
  const submitted=offlineRequest("gpt-6-astra","max");
  await driver.execute({request:submitted,renderedPrompt:renderActionPrompt(submitted.prompt),signal:new AbortController().signal,emit:()=>{}});
  expect(await page.evaluate(()=>document.body.dataset.effortChanges)).toBe("0");
  expect(await page.evaluate(()=>document.body.dataset.familyChanges)).toBe("");
  expect(await page.evaluate(()=>document.body.dataset.sentEffort)).toBe("Pro");
},15_000);

test.skipIf(!native)("a locked destination effort or changed account prevents selection and Send",async()=>{
  for(const mismatch of [false,true]) {
    const driver=await fixture("",true,connector,0,false,true,{family:"6",value:4,locked:[2]});
    const submitted={...offlineRequest("gpt-6-sol","high"),expectedAccountFingerprint:mismatch?"another-account":request.expectedAccountFingerprint};
    let failure:unknown;
    try {await driver.execute({request:submitted,renderedPrompt:renderActionPrompt(submitted.prompt),signal:new AbortController().signal,emit:()=>{}});}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(Error);
    expect(await page.evaluate(()=>document.body.dataset.sends)).toBe("0");
    expect(await page.evaluate(()=>document.body.dataset.effortChanges)).toBe("0");
    expect(await composerText(await activeComposer(page))).toBe("");
  }
},15_000);

test.skipIf(!native)("a stale catalog index does not override the destination's native effort labels",async()=>{
  const driver=await fixture();
  await driver.capabilities();
  // The old catalog places High at index 3. The destination now exposes it at index 2.
  shiftedEfforts=true;
  await page.goto("https://chatgpt.com/c/unrelated-conversation");
  const submitted=offlineRequest("gpt-5.5-sol","high");
  await driver.execute({request:submitted,renderedPrompt:renderActionPrompt(submitted.prompt),signal:new AbortController().signal,emit:()=>{}});
  expect(await page.evaluate(()=>[document.body.dataset.sentFamily,document.body.dataset.sentEffort])).toEqual(["5.5","High"]);
  expect(await page.locator('[role="slider"]').getAttribute('aria-valuenow')).toBe("9");
},15_000);

test.skipIf(!native)("unlabeled destination ticks use a verified cache hint or work without a cache",async()=>{
  for(const warm of [false,true]) {
    const driver=await fixture();
    if(warm) await driver.capabilities();
    hideEffortLabels=true;
    await page.goto("https://chatgpt.com/c/unrelated-conversation");
    const submitted=offlineRequest("gpt-6-sol",warm?"high":"low");
    await driver.execute({request:submitted,renderedPrompt:renderActionPrompt(submitted.prompt),signal:new AbortController().signal,emit:()=>{}});
    expect(await page.evaluate(()=>document.body.dataset.familyChanges)).toBe("");
    expect(await page.evaluate(()=>document.body.dataset.effortChanges)).toBe(warm?"2":"4");
    expect(await page.evaluate(()=>document.body.dataset.sentEffort)).toBe(warm?"High":"Instant");
  }
},20_000);

test.skipIf(!native)("a destination effort locked after selection prevents Send",async()=>{
  const driver=await fixture("",false);
  const submitted=offlineRequest("gpt-6-sol","high");
  const run=driver.execute({request:submitted,renderedPrompt:renderActionPrompt(submitted.prompt),signal:new AbortController().signal,emit:()=>{}}).then(()=>undefined,error=>error);
  await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]')!.textContent!.includes('goal'));
  await page.locator('[data-selected="true"]').evaluate(element=>element.setAttribute('data-locked','true'));
  await page.locator('button[type="submit"]').evaluate(element=>(element as HTMLButtonElement).disabled=false);
  const failure=await run;
  expect(failure).toBeInstanceOf(Error);
  expect(await page.evaluate(()=>document.body.dataset.sends)).toBe("0");
},15_000);

test.skipIf(!native)("pairing uses Medium for each model family and restores the exact original effort",async()=>{
  for(const model of [{family:"6",value:4,locked:[]},{family:"5.6",value:2,locked:[]},{family:"5.5",value:11,locked:[]}]) {
    const driver=await fixture("",true,connector,31_000,false,true,model);
    const started=Date.now();
    await driver.execute({request,renderedPrompt:prompt,signal:new AbortController().signal,emit:()=>{}});
    expect(Date.now()-started).toBeLessThan(10_000);
    expect(await page.evaluate(()=>document.body.dataset.sentEffort)).toBe("Medium");
    expect(await page.evaluate(()=>document.body.dataset.sentFamily)).toBe(model.family);
    expect(await page.locator('[role="slider"]').getAttribute('aria-valuenow')).toBe(String(model.value));
    expect(await page.evaluate(()=>document.body.dataset.family)).toBe(model.family);
    expect(await page.locator('#effort').getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('[data-testid="stop-button"]').count()).toBe(1);
    expect(request.model).toBeNull();expect(request.effort).toBeNull();
  }
},30_000);

test.skipIf(!native)("already-Medium pairing does not move the effort slider",async()=>{
  const driver=await fixture("",true,connector,0,false,true,{family:"6",value:1,locked:[]});
  await driver.execute({request,renderedPrompt:prompt,signal:new AbortController().signal,emit:()=>{}});
  expect(await page.evaluate(()=>document.body.dataset.sentEffort)).toBe("Medium");
  expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("Medium");
  expect(await page.evaluate(()=>document.body.dataset.effortChanges)).toBe("0");
},15_000);

test.skipIf(!native)("unavailable Medium preserves the chosen settings without sending a pairing turn",async()=>{
  const driver=await fixture("",true,connector,0,false,true,{family:"6",value:4,locked:[1]});
  let failure:unknown;
  try { await driver.execute({request,renderedPrompt:prompt,signal:new AbortController().signal,emit:()=>{}}); } catch(error) {failure=error;}
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("Medium mode is unavailable");
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(0);
  expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("Pro");
  expect(await page.locator('#effort').getAttribute('aria-expanded')).toBe('false');
},15_000);

test.skipIf(!native)("external model or effort changes during pairing are preserved and prevent Send",async()=>{
  for(const changed of ["family","effort"]) {
    const driver=await fixture("",false);
    const run=driver.execute({request,renderedPrompt:prompt,signal:new AbortController().signal,emit:()=>{}}).then(()=>undefined,error=>error);
    await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]')!.textContent!.includes('automation_verify_pairing'));
    await page.locator('#effort').click();
    if(changed==='family') await page.locator('[data-family="5.6"]').click();
    for(let index=0;index<(changed==='family'?2:1);index++) await page.locator('#range').press(changed==='family'?'ArrowLeft':'ArrowRight');
    await page.keyboard.press('Escape');
    await page.locator('button[type="submit"]').evaluate(element=>(element as HTMLButtonElement).disabled=false);
    const error=await run;expect(error).toBeInstanceOf(Error);
    expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(0);
    expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("High");
    expect(await page.evaluate(()=>document.body.dataset.family)).toBe(changed==='family'?'5.6':'6');
  }
},20_000);

test.skipIf(!native)("automatic pairing uses Medium before applying the configured conversation model",async()=>{
  const driver=await fixture("",true,connector,31_000,false,true,{family:"5.6",value:2,locked:[]});
  const create:ExecuteActionRequest={...request,url:"https://chatgpt.com/new",expectedUrl:"https://chatgpt.com/new",model:"gpt-6-astra",effort:"max",prompt:{kind:"create_chat",reference:newReference,continuationToken:Buffer.alloc(32,2).toString('base64url'),setupReference:null}};
  const events:Parameters<DriverExecution['emit']>[0][]=[];
  const coordinator=new SingleWindowCoordinator(driver,build);
  await coordinator.execute(create);for await(const event of coordinator.events(create.actionId,0))events.push(event);
  expect(await page.evaluate(()=>document.body.dataset.sentEffort)).toBe("Medium");
  expect(await page.evaluate(()=>document.body.dataset.sentFamily)).toBe("5.6");
  expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("Pro");
  expect(await page.evaluate(()=>document.body.dataset.family)).toBe("6");
  expect(create.model).toBe("gpt-6-astra");expect(create.effort).toBe("max");
  expect(events.findIndex(event=>event.type==='model_verified')).toBeGreaterThan(events.findIndex(event=>event.type==='send_accepted'));
  expect(events.at(-1)).toMatchObject({type:'submission_complete',canonicalUrl:'https://chatgpt.com/c/new-created-fixture'});
  expect(await page.locator('[data-testid="stop-button"]').count()).toBe(1);
  expect((await coordinator.action(create.actionId))?.selected).toEqual({model:"gpt-6-astra",effort:"max"});
},30_000);

test.skipIf(!native)("cancelled automatic pairing preserves the original composer and configured preferences",async()=>{
  const driver=await fixture("",false,connector,0,false,true,{family:"5.6",value:2,locked:[]});
  const create:ExecuteActionRequest={...request,url:"https://chatgpt.com/new",expectedUrl:"https://chatgpt.com/new",model:"gpt-6-astra",effort:"max",prompt:{kind:"create_chat",reference:newReference,continuationToken:Buffer.alloc(32,2).toString('base64url'),setupReference:null}};
  const controller=new AbortController();
  const run=driver.execute({request:create,renderedPrompt:renderActionPrompt(create.prompt),signal:controller.signal,emit:()=>{}}).then(()=>undefined,error=>error);
  await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]')!.textContent!.includes('continue_task'));
  controller.abort();expect(await run).toBeInstanceOf(Error);
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(0);
  expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("High");
  expect(await page.evaluate(()=>document.body.dataset.family)).toBe("5.6");
  expect(create.model).toBe("gpt-6-astra");expect(create.effort).toBe("max");
  expect(await composerText(await activeComposer(page))).toBe('');
},15_000);

test.skipIf(!native)("automatic pairing cannot fall back to a configured thinking request when Medium is locked",async()=>{
  const driver=await fixture("",true,connector,0,false,true,{family:"5.6",value:2,locked:[1]});
  const create:ExecuteActionRequest={...request,url:"https://chatgpt.com/new",expectedUrl:"https://chatgpt.com/new",model:"gpt-6-astra",effort:"max",prompt:{kind:"create_chat",reference:newReference,continuationToken:Buffer.alloc(32,2).toString('base64url'),setupReference:null}};
  const failure=await driver.execute({request:create,renderedPrompt:renderActionPrompt(create.prompt),signal:new AbortController().signal,emit:()=>{}}).then(()=>undefined,error=>error);
  expect(failure).toMatchObject({code:"model_unavailable",sendAccepted:false});
  expect(await page.evaluate(()=>document.body.dataset.sends)).toBe("0");
  expect(await page.evaluate(()=>[document.body.dataset.family,document.body.dataset.effort])).toEqual(["5.6","High"]);
  expect(create.model).toBe("gpt-6-astra");expect(create.effort).toBe("max");
},15_000);

test.skipIf(!native)("existing-chat pairing ignores configured model selection and restores its original choice",async()=>{
  const driver=await fixture("",true,connector,31_000,false,true,{family:"5.6",value:2,locked:[]});
  const configured={...request,model:"gpt-6-astra",effort:"max"};
  await driver.execute({request:configured,renderedPrompt:prompt,signal:new AbortController().signal,emit:()=>{}});
  expect(await page.evaluate(()=>[document.body.dataset.sentFamily,document.body.dataset.sentEffort])).toEqual(["5.6","Medium"]);
  expect(await page.evaluate(()=>[document.body.dataset.family,document.body.dataset.effort])).toEqual(["5.6","High"]);
  expect(configured.model).toBe("gpt-6-astra");expect(configured.effort).toBe("max");
},15_000);

test.skipIf(!native)("an aborted pre-Send wait clears only the unchanged owned prompt",async()=>{
  for (const edited of [false,true]) {
    const driver=await fixture("",false);const controller=new AbortController();
    const run=driver.execute({request,renderedPrompt:prompt,signal:controller.signal,emit:()=>{}}).then(()=>undefined,error=>error);
    await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]')!.textContent!.includes('automation_verify_pairing'));
    if (edited) await page.locator('[contenteditable="true"]').pressSequentially(" user edit");
    const beforeAbort=await composerText(await activeComposer(page));
    controller.abort();const failure=await run;
    expect(failure).toBeDefined();
    expect(await page.evaluate(()=> Number(document.body.dataset.sends))).toBe(0);
    const draft=await composerText(await activeComposer(page));
    expect(draft).toBe(edited?beforeAbort:"");
    expect((await driver.health()).status).toBe(edited?"busy":"idle");
    expect(await page.evaluate(()=>document.body.dataset.effort)).toBe("Pro");
  }
},15_000);

test.skipIf(!native)("Replace pairing recovers an old verification draft without resubmitting its reference",async()=>{
  const driver=await fixture(oldPrompt);const coordinator=new SingleWindowCoordinator(driver,build);
  expect((await coordinator.health()).status).toBe("busy");
  expect((await coordinator.health()).activeActionId).toBeNull();
  await coordinator.execute(request);
  const events=[];for await (const event of coordinator.events(request.actionId,0)) events.push(event);
  expect(await page.evaluate(()=> Number(document.body.dataset.sends))).toBe(1);
  expect(await page.evaluate(()=> document.body.dataset.sentText)).toContain(newReference);
  expect(await page.evaluate(()=> document.body.dataset.sentText)).not.toContain("A".repeat(43));
  expect(events.at(-1)?.type).toBe("submission_complete");
  expect((await coordinator.health()).activeActionId).toBeNull();
},15_000);

test.skipIf(!native)("an exact connector menu choice binds an unrelated internal chip name to its app identity",async()=>{
  const driver=await fixture(oldPrompt,true,"internal-name-unrelated-to-display-label");
  const coordinator=new SingleWindowCoordinator(driver,build);
  await coordinator.execute(request);
  const events=[];for await (const event of coordinator.events(request.actionId,0)) events.push(event);
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(1);
  expect(events.at(-1)?.type).toBe("submission_complete");
},15_000);

test.skipIf(!native)("a connector app identity changed after selection is rejected before Send",async()=>{
  const driver=await fixture("",false,"internal-name-unrelated-to-display-label");
  const run=driver.execute({request,renderedPrompt:prompt,signal:new AbortController().signal,emit:()=>{}})
    .then(()=>undefined,error=>error);
  await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]')!.textContent!.includes('automation_verify_pairing'));
  await page.locator('[app-mention-path]').evaluate(element=>element.setAttribute('app-mention-path','app://different-app'));
  await page.locator('button[type="submit"]').evaluate(element=>(element as HTMLButtonElement).disabled=false);
  const failure=await run;
  expect((failure as Error).message).toContain("changed the selected connector");
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(0);
  expect(await composerText(await activeComposer(page))).toBe(prompt);
},15_000);

test.skipIf(!native)("pairing preserves edited drafts, different conversations, missing connectors, and running generations",async()=>{
  for (const kind of ["user","edited","other-conversation","missing-connector","generating","approval"]) {
    const draft=kind==="user"?"My own draft":kind==="edited"?oldPrompt+" edited":oldPrompt;
    const driver=await fixture(draft);
    if (kind==="missing-connector") await page.locator('[app-mention-path]').evaluate(element=>element.remove());
    if (kind==="generating") await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<button data-testid="stop-button">Stop</button>'));
    if (kind==="approval") await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div role="dialog">Allow ChatGPT to use Fixture connector?</div>'));
    const submitted=kind==="other-conversation"?{...request,expectedUrl:"https://chatgpt.com/c/other"}:request;
    expect(await driver.replacePairingDraft(submitted)).toBeFalse();
    expect(await composerText(await activeComposer(page))).toBe(draft);
    expect(await page.evaluate(()=> Number(document.body.dataset.sends))).toBe(0);
  }
},15_000);

test.skipIf(!native)("Send readiness has a deadline and rejects multiple owned submitters",async()=>{
  await fixture("draft",false);const composer=await activeComposer(page);
  let failure:unknown;try {await uniqueSendButton(composer,100);}catch(error){failure=error;}
  expect((failure as Error).message).toContain("did not become ready");
  await page.evaluate(()=>document.querySelector('form')!.insertAdjacentHTML('beforeend','<button type="submit">Other submit</button>'));
  try {await uniqueSendButton(composer,100);}catch(error){failure=error;}
  expect((failure as Error).message).toContain("one visible Send control");
},5_000);

test.skipIf(!native)("composer text preserves native paragraph, hard-break and blank-line boundaries",async()=>{
  await fixture();
  const composer=await activeComposer(page);
  for (const placeholder of ['<br>','<br class="ProseMirror-trailingBreak">']) {
    await composer.evaluate((element,breakMarkup)=>{
      element.innerHTML='<p><span app-mention-path="app://fixture" contenteditable="false">internal-name</span> line  one</p><p>line two<br>hard break</p><p>'+breakMarkup+'</p><p>last line</p>';
    },placeholder);
    expect(await composerText(composer)).toBe("line  one\nline two\nhard break\n\nlast line");
  }
},5_000);

test.skipIf(!native)("submission releases the window while the response continues without observation",async()=>{
  const driver=await fixture("",true,connector,31_000);
  const coordinator=new SingleWindowCoordinator(driver,build);
  const began=Date.now();
  await coordinator.execute(request);
  const events=[];for await(const event of coordinator.events(request.actionId,0)) events.push(event);
  expect(Date.now()-began).toBeLessThan(10_000);
  expect(events.some(event=>["status_delta","commentary_delta","answer_delta","generation_complete"].includes(event.type))).toBeFalse();
  expect(events.at(-1)?.type).toBe("submission_complete");
  expect(await page.locator('[data-testid="stop-button"]').count()).toBe(1);
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(1);
  expect((await coordinator.health()).activeActionId).toBeNull();
  expect((await coordinator.health()).status).toBe("idle");
  const nextUrl="https://chatgpt.com/c/another-pair-fixture";
  const next={...request,actionId:"next-pair",idempotencyKey:"next-pair-key",url:nextUrl,expectedUrl:nextUrl};
  await coordinator.execute(next);
  const nextEvents=[];for await(const event of coordinator.events(next.actionId,0)) nextEvents.push(event);
  expect(nextEvents.at(-1)?.type).toBe("submission_complete");
},15_000);

test.skipIf(!native)("offline messages and goals stop lingering generation before Send and then release the queue",async()=>{
  const prompts:ExecuteActionRequest["prompt"][]=[
    {kind:"offline_chat",batchId:"offline-batch",messages:[{id:"offline-message",markdown:"Continue from here"}]},
    {kind:"offline_goal",goalRevision:1},
    {kind:"offline_combined",batchId:"combined-batch",messages:[{id:"combined-message",markdown:"An additional instruction"}],goalRevision:1},
  ];
  for (const actionPrompt of prompts) {
    const driver=await fixture("",true,connector,31_000,true);
    const coordinator=new SingleWindowCoordinator(driver,build);
    const offline={...request,prompt:actionPrompt};
    await coordinator.execute(offline);
    const events=[];for await(const event of coordinator.events(offline.actionId,0)) events.push(event);
    expect(events.at(-1)).toMatchObject({type:"submission_complete"});
    expect(await page.evaluate(()=>document.body.dataset.order)).toBe("stop,stopped,send,");
    expect(await page.evaluate(()=>Number(document.body.dataset.stops))).toBe(1);
    expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(1);
    expect(await page.locator('[data-testid="stop-button"]').count()).toBe(1);
    expect(events.at(-1)?.type).toBe("submission_complete");
    expect((await coordinator.health()).activeActionId).toBeNull();
  }
},15_000);

test.skipIf(!native)("offline Stop requires the paired conversation and account before clicking",async()=>{
  for (const mismatch of ["conversation","account"]) {
    const driver=await fixture("",true,connector,0,true);
    const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1},
      ...(mismatch==="conversation"?{expectedUrl:"https://chatgpt.com/c/other"}:{expectedAccountFingerprint:"other-account"})};
    const failure=await driver.execute({request:offline,renderedPrompt:renderActionPrompt(offline.prompt),signal:new AbortController().signal,emit:()=>{}}).then(()=>undefined,error=>error);
    expect(failure).toMatchObject({code:mismatch==="conversation"?"conversation_unavailable":"authentication_required"});
    expect(await page.locator("body").getAttribute("data-stops")).toBe("0");
    expect(await page.locator("body").getAttribute("data-sends")).toBe("0");
  }
},10_000);

test.skipIf(!native)("an ignored first Stop is retried automatically before sending once",async()=>{
  const driver=await fixture("",true,connector,0,true,2);
  const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1}};
  await driver.execute({request:offline,renderedPrompt:renderActionPrompt(offline.prompt),signal:new AbortController().signal,emit:()=>{}});
  expect(await page.locator("body").getAttribute("data-order")).toBe("stop,stop,stopped,send,");
  expect(await page.locator("body").getAttribute("data-sends")).toBe("1");
  expect(documentLoads).toBe(2);
},15_000);

test.skipIf(!native)("a stuck Stop is rehydrated and stopped automatically before sending once",async()=>{
  const driver=await fixture("",true,connector,0,true,"reload");
  const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1}};
  await driver.execute({request:offline,renderedPrompt:renderActionPrompt(offline.prompt),signal:new AbortController().signal,emit:()=>{}});
  expect(documentLoads).toBe(3);
  expect(await page.locator("body").getAttribute("data-order")).toBe("stop,stopped,send,");
  expect(await page.locator("body").getAttribute("data-sends")).toBe("1");
},20_000);

test.skipIf(!native)("Stop recovery does not discard a user draft to reload the conversation",async()=>{
  const driver=await fixture("A draft I am writing",true,connector,0,true,false);
  const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1}};
  const failure=await driver.execute({request:offline,renderedPrompt:renderActionPrompt(offline.prompt),signal:new AbortController().signal,emit:()=>{}}).then(()=>undefined,error=>error);
  expect(failure).toMatchObject({code:"external_interference"});
  expect(documentLoads).toBe(2);
  expect(await composerText(await activeComposer(page))).toBe("A draft I am writing");
  expect(await page.locator("body").getAttribute("data-sends")).toBe("0");
},20_000);

test.skipIf(!native)("Stop recovery revalidates the account and conversation after reload",async()=>{
  for(const mismatch of ["account","conversation"]){
    const driver=await fixture("",true,connector,0,true,false);
    changedAccountAfterReload=mismatch==="account";changedUrlAfterReload=mismatch==="conversation";
    const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1}};
    const failure=await driver.execute({request:offline,renderedPrompt:renderActionPrompt(offline.prompt),signal:new AbortController().signal,emit:()=>{}}).then(()=>undefined,error=>error);
    expect(failure).toMatchObject({code:mismatch==="account" ? "authentication_required" : "conversation_unavailable"});
    expect(documentLoads).toBe(3);
    expect(await page.locator("body").getAttribute("data-stops")).toBe("0");
    expect(await page.locator("body").getAttribute("data-sends")).toBe("0");
  }
},35_000);

test.skipIf(!native)("a cancelled offline Stop never inserts or sends its prompt",async()=>{
  const driver=await fixture("",true,connector,0,true,false);
  const controller=new AbortController();
  const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1}};
  const run=driver.execute({request:offline,renderedPrompt:renderActionPrompt(offline.prompt),signal:controller.signal,emit:()=>{}}).then(()=>undefined,error=>error);
  await page.waitForFunction(()=>document.body.dataset.stops==="1");
  controller.abort();
  expect(await run).toBeDefined();
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(0);
  expect(await composerText(await activeComposer(page))).toBe("");
},10_000);

test.skipIf(!native)("an unresponsive Stop times out before Send and releases browser ownership",async()=>{
  const driver=await fixture("",true,connector,0,true,false);
  const coordinator=new SingleWindowCoordinator(driver,build);
  const offline:ExecuteActionRequest={...request,prompt:{kind:"offline_goal",goalRevision:1}};
  const began=Date.now();
  await coordinator.execute(offline);
  const events=[];for await(const event of coordinator.events(offline.actionId,0)) events.push(event);
  expect(Date.now()-began).toBeLessThan(12_000);
  expect(events.at(-1)).toMatchObject({type:"failed",message:"ChatGPT did not stop the previous response; the new message was not sent"});
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(0);
  expect((await coordinator.action(offline.actionId))?.sendAccepted).toBeFalse();
  expect((await coordinator.health()).activeActionId).toBeNull();
},15_000);

test.skipIf(!native)("chat ID survives project, ordinary-route, and slug rewrites during submission",async()=>{
  const project="g-p-0123456789abcdef0123456789abcdef";
  const conversation="12345678-1234-4321-8765-123456789abc";
  const shortUrl=`https://chatgpt.com/g/${project}/c/${conversation}`;
  const longUrl=`https://chatgpt.com/g/${project}-original-project/c/${conversation}`;
  for (const navigationUrl of [shortUrl, `https://chatgpt.com/c/${conversation}`, shortUrl.replace(project,"g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]) {
  await fixture();
  const rewritingSurface:SingleBrowserSurface={...surface,navigate:async destination=>{
    const loaded=await surface.navigate(destination);
    await loaded.evaluate(({navigationUrl,longUrl})=>{
      history.replaceState({},"",navigationUrl);
      document.querySelector('[contenteditable="true"]')!.addEventListener('input',()=>history.replaceState({},"",longUrl),{once:true});
    },{navigationUrl,longUrl});
    return loaded;
  }};
  const driver=new ChatGptBrowserDriver(rewritingSurface,build);
  const coordinator=new SingleWindowCoordinator(driver,build);
  const projected:ExecuteActionRequest={...request,url:longUrl,expectedUrl:longUrl,prompt:{kind:"offline_goal",goalRevision:1}};
  await coordinator.execute(projected);
  const events=[];for await(const event of coordinator.events(projected.actionId,0))events.push(event);
  expect(events.at(-1)).toMatchObject({type:"submission_complete",canonicalUrl:`https://chatgpt.com/c/${conversation}`});
  expect((await coordinator.action(projected.actionId))?.canonicalUrl).toBe(`https://chatgpt.com/c/${conversation}`);
  expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(1);
  expect((await coordinator.health()).activeActionId).toBeNull();
  }
},10_000);

test.skipIf(!native)("a different chat ID before Send remains rejected",async()=>{
  const expected="https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-original-project/c/12345678-1234-4321-8765-123456789abc";
  for(const actual of [expected.replace('12345678-1234-4321-8765-123456789abc','other-conversation')]) {
    await fixture();
    const movedSurface:SingleBrowserSurface={...surface,navigate:async destination=>{
      const loaded=await surface.navigate(destination);
      await loaded.evaluate(actual=>document.querySelector('[contenteditable="true"]')!.addEventListener('input',()=>history.replaceState({},"",actual),{once:true}),actual);
      return loaded;
    }};
    const driver=new ChatGptBrowserDriver(movedSurface,build);
    const coordinator=new SingleWindowCoordinator(driver,build);
    const projected:ExecuteActionRequest={...request,url:expected,expectedUrl:expected,prompt:{kind:"offline_goal",goalRevision:1}};
    await coordinator.execute(projected);
    const events=[];for await(const event of coordinator.events(projected.actionId,0))events.push(event);
    expect(events.at(-1)).toMatchObject({type:"failed",code:"conversation_unavailable"});
    expect(await page.locator("body").getAttribute("data-sends")).toBe("0");
    expect((await coordinator.action(projected.actionId))?.sendAccepted).toBeFalse();
  }
},10_000);

test.skipIf(!native)("new chats bind the created URL after sending the initialization prompt",async()=>{
  for(const destination of ["https://chatgpt.com/new","https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project"]){
    await fixture();
    const creationSurface:SingleBrowserSurface={...surface,navigate:async target=>{
      const loaded=await surface.navigate(target);
      await loaded.evaluate(()=>document.querySelector('form')!.addEventListener('submit',()=>history.replaceState({},"","/c/new-created-chat")));
      return loaded;
    }};
    class CreationDriver extends ChatGptBrowserDriver { override async capabilities(){return {protocolVersion:1 as const,build,accountFingerprint:request.expectedAccountFingerprint,catalogRevision:"fixture",models:[{id:"fixture-model",label:"Fixture model",efforts:[{id:"fixture-effort",label:"Fixture effort",available:true,reason:null}]}]};} }
    const driver=new CreationDriver(creationSurface,build);
    const coordinator=new SingleWindowCoordinator(driver,build);
    const creation:ExecuteActionRequest={...request,url:destination,expectedUrl:destination,prompt:{kind:"create_chat",continuationToken:"A".repeat(43),reference:newReference,setupReference:null}};
    await coordinator.execute(creation);const events=[];for await(const event of coordinator.events(creation.actionId,0))events.push(event);
    expect(events.at(-1)).toMatchObject({type:"submission_complete",canonicalUrl:"https://chatgpt.com/c/new-created-chat"});
    expect(await page.evaluate(()=>document.body.dataset.sentText)).toContain("continue_task");
    expect(await page.evaluate(()=>Number(document.body.dataset.sends))).toBe(1);
    expect((await coordinator.health()).activeActionId).toBeNull();
  }
},15_000);


test.skipIf(!native)("new chat creation waits for the persistent URL instead of retaining the local draft ID",async()=>{
  await fixture();
  await page.evaluate(()=>history.replaceState({},"","/c/local-chatgpt%3Adraft-fixture"));
  const began=Date.now();
  await page.evaluate(()=>setTimeout(()=>history.replaceState({},"","/c/persistent-fixture"),250));
  const {createdChatUrl}=await import("../src/new-chat");
  expect(await createdChatUrl(page,new AbortController().signal)).toBe("https://chatgpt.com/c/persistent-fixture");
  expect(Date.now()-began).toBeGreaterThanOrEqual(200);
});

test.skipIf(!native)("health polling fetches one session while draft and page state remain live",async()=>{
  const driver=await fixture();
  for(const health of await Promise.all(Array.from({length:20},()=>driver.health())))expect(health.status).toBe('idle');
  for(let i=0;i<10;i++)expect((await driver.health()).authenticated).toBeTrue();
  expect(sessionRequests).toBe(1);
  await page.locator('[contenteditable="true"]').evaluate(element=>element.textContent='A draft I am writing');
  expect((await driver.health()).status).toBe('busy');expect(sessionRequests).toBe(1);
  await page.reload();expect((await driver.health()).status).toBe('idle');expect(sessionRequests).toBe(2);
},15_000);

test.skipIf(!native)("a cached healthy identity cannot authorize a send after the account changes",async()=>{
  const driver=await fixture(),coordinator=new SingleWindowCoordinator(driver,build);
  expect((await coordinator.health()).authenticated).toBeTrue();expect(sessionRequests).toBe(1);
  changedAccountAfterReload=true;documentLoads=3;
  expect((await coordinator.health()).authenticated).toBeTrue();expect(sessionRequests).toBe(1);
  await coordinator.execute(request);const events=[];for await(const event of coordinator.events(request.actionId,0))events.push(event);
  expect(events.at(-1)?.type).toBe('authentication_required');expect((await coordinator.action(request.actionId))?.sendAccepted).toBeFalse();
  expect(await page.evaluate(()=>document.body.dataset.sends)).toBe('0');expect(sessionRequests).toBe(2);
},15_000);


test.skipIf(!native)("a created conversation URL is retained when applying the saved model fails after Send",async()=>{
 const driver=await fixture("",true,connector,0,false,true,{family:"5.6",value:2,locked:[]});
 const create:ExecuteActionRequest={...request,url:"https://chatgpt.com/new",expectedUrl:"https://chatgpt.com/new",model:"gpt-99-sol",effort:"max",prompt:{kind:"create_chat",reference:newReference,continuationToken:Buffer.alloc(32,2).toString('base64url'),setupReference:null}};
 const coordinator=new SingleWindowCoordinator(driver,build),events:Parameters<DriverExecution['emit']>[0][]=[];
 await coordinator.execute(create);for await(const event of coordinator.events(create.actionId,0))events.push(event);
 const created=events.findIndex(event=>event.type==='conversation_created');
 expect(created).toBeGreaterThan(events.findIndex(event=>event.type==='send_accepted'));
 expect(events[created]).toMatchObject({type:'conversation_created',canonicalUrl:'https://chatgpt.com/c/new-created-fixture'});
 expect(events.at(-1)?.type).not.toBe('submission_complete');
 expect((await coordinator.action(create.actionId))?.canonicalUrl).toBe('https://chatgpt.com/c/new-created-fixture');
 expect((await coordinator.action(create.actionId))?.sendAccepted).toBeTrue();
 expect(await page.evaluate(()=>document.body.dataset.sends)).toBe('1');
},20_000);
