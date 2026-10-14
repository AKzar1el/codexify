import type {Page} from "patchright";
import {readChatGptAccount} from "./account";
import {selectConnector,SELECTED_CONNECTOR_SELECTOR} from "./connector-selection";
import {BrowserCompanionError,selectorDrift} from "./errors";

export type AccountPlan = {label:string; sourceLabel:string; kind:"free"|"go"|"pro"|"unknown"; accountFingerprint:string};
function traceRefresh(phase:string):void {
  if(process.env.CODEXIFY_BROWSER_MAINTENANCE_TRACE==="1")console.info(`[connector-refresh] ${Date.now()} ${phase}`);
}

export function classifyPlan(sourceLabel:string): Omit<AccountPlan,"accountFingerprint"> {
  const label=sourceLabel.normalize("NFKC").replace(/\s+/g," ").trim().slice(0,128);
  const normalized=label.replace(/^ChatGPT\s+/i,"").replace(/_/g," ").trim();
  if (/^Free(?:\s+plan)?$/i.test(normalized)) return {label:"Free",sourceLabel:label,kind:"free"};
  if (/^Go(?:\s+plan)?$/i.test(normalized)) return {label:"Go",sourceLabel:label,kind:"go"};
  if (/^Pro\b/i.test(normalized)) {
    const tier=/\b(5x|20x|25x|50|200|250)\b/i.exec(normalized)?.[1]?.toLowerCase();
    const aliases:Record<string,string>={"50":"5x","200":"20x","250":"25x","5x":"5x","20x":"20x","25x":"25x"};
    return {label:tier?`Pro ${aliases[tier]}`:/^pro$/i.test(normalized)?"Pro":label,sourceLabel:label,kind:"pro"};
  }
  return {label:label||"Plan unavailable",sourceLabel:label,kind:"unknown"};
}

export async function readBillingPlan(page:Page,signal?:AbortSignal):Promise<AccountPlan> {
  await page.goto("https://chatgpt.com/settings/billing",{waitUntil:"domcontentloaded",timeout:5_000,signal});
  await page.locator("body").waitFor({state:"visible",signal});
  const account=await readChatGptAccount(page);
  let sourceLabel:string|null|undefined;
  // Leave room for account verification and restoring the shared tab within the 10s action budget.
  const deadline=Date.now()+2_500;
  do {
  signal?.throwIfAborted();
  sourceLabel=await page.evaluate(()=>{
    const visible=(node:Element)=>node.getClientRects().length>0;
    const uniquePlan=(labels:string[])=>new Set(labels.map(label=>label.replace(/^ChatGPT\s+/i,"").toLowerCase())).size===1
      ? labels.find(label=>/^ChatGPT\s+/i.test(label))??labels[0] : null;
    const direct=[...document.querySelectorAll('[data-testid="current-plan"],[data-testid="plan-name"],[data-current-plan]')].filter(visible)
      .map(node=>node.textContent?.trim()).filter((text):text is string=>Boolean(text&&text.length<=128));
    if(uniquePlan(direct))return uniquePlan(direct);
    const headings=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible)
      .map(node=>node.textContent?.replace(/\s+/g," ").trim()).filter((text):text is string=>Boolean(text&&(/^(?:ChatGPT\s+)?(?:Free|Go|Pro|Plus|Business|Enterprise|Edu)\b/i.test(text)||/^ChatGPT\s+\S/i.test(text))&&text.length<=128));
    if(uniquePlan(headings))return uniquePlan(headings);
    const labels=[...document.querySelectorAll('p,span,strong,div')].filter(visible)
      .map(node=>node.textContent?.replace(/\s+/g," ").trim()).filter((text):text is string=>Boolean(text&&/^(?:ChatGPT\s+)?(?:Free|Go|Pro(?:\s+(?:5x|20x|25x|50|200|250))?|Plus|Business|Enterprise|Edu)(?:\s+plan)?$/i.test(text)));
    return uniquePlan(labels);
  });
  if(sourceLabel)break;
  await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<deadline);
  if(process.env.CODEXIFY_BROWSER_MAINTENANCE_TRACE==="1") {
    const candidates=await page.locator("body").innerText().then(text=>text.split("\n").map(line=>line.trim()).filter(line=>/^(?:ChatGPT\s+)?(?:Free|Go|Pro|Plus|Business|Enterprise|Edu)\b/i.test(line)&&line.length<=128));
    console.info(`[account-plan] ${JSON.stringify({sourceLabel:sourceLabel??null,sessionPlan:account.planType,candidates})}`);
  }
  return {...classifyPlan(sourceLabel||account.planType),accountFingerprint:account.fingerprint};
}

async function markRefreshButton(page:Page):Promise<void> {
  const marked=await page.evaluate(()=>{
    for(const button of document.querySelectorAll('button'))button.removeAttribute('data-refresh-tools-target');
    const direct=[...document.querySelectorAll<HTMLButtonElement>('button[data-testid*="refresh"],button[data-action="refresh-tools"],button[name="refresh_tools"]')].filter(button=>button.getClientRects().length>0);
    if(direct.length===1){direct[0]!.setAttribute('data-refresh-tools-target','true');return true;}
    const candidates=new Set<HTMLButtonElement>();
    // The Manage app card has two edit controls, Refresh, then a destructive Delete.
    // This evidence is independent of the translated labels and never selects the Delete row.
    for(const node of document.querySelectorAll('div,section')) {
      const buttons=[...node.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.getClientRects().length>0);
      if(buttons.length!==4)continue;
      const destructive=(button:HTMLButtonElement)=>{const color=getComputedStyle(button).color;const c=/^rgba?\(/.test(color)?color.match(/\d+/g)?.map(Number)||[]:[];return c.length>=3&&c[0]!>c[1]!*1.3&&c[0]!>c[2]!*1.3;};
      if(destructive(buttons[3]!)&&buttons.slice(0,3).every(button=>!destructive(button)))candidates.add(buttons[2]!);
    }
    if(candidates.size===1){[...candidates][0]!.setAttribute('data-refresh-tools-target','true');return true;}
    return false;
  });
  if(!marked)throw selectorDrift("ChatGPT did not expose one identifiable tool-refresh control");
}

async function allowAllChoice(page:Page,signal?:AbortSignal) {
  const radios=page.locator('[role="radio"],input[type="radio"]').filter({visible:true});
  await radios.first().waitFor({state:"visible",timeout:10_000,signal});
  if(await radios.count()!==4)throw selectorDrift("ChatGPT permission choices changed; Allow all was not selected");
  const choice=radios.nth(3);
  const checked=()=>choice.getAttribute("aria-checked").then(value=>value==="true").then(async value=>value||await choice.isChecked().catch(()=>false));
  return {choice,checked};
}

async function ensureAllowAll(page:Page,assertPage:()=>Promise<void>,signal?:AbortSignal):Promise<boolean> {
  signal?.throwIfAborted();
  const {choice,checked}=await allowAllChoice(page,signal);
  const changed=!await checked();
  if(changed){await assertPage();signal?.throwIfAborted();await choice.click({timeout:5_000,signal});}
  const deadline=Date.now()+5_000;
  while(!await checked()&&Date.now()<deadline){signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,50));}
  if(!await checked())throw selectorDrift("ChatGPT did not confirm Allow all tools");
  return changed;
}

export async function observedConnectorApp(page:Page,name:string):Promise<string|undefined> {
  const identities=await page.evaluate(name=>{
    const ids=new Set<string>();
    for(const node of document.querySelectorAll('a[href], [app-mention-path], [data-id^="plugin:"]')) {
      if(!node.getClientRects().length)continue;
      const label=node.getAttribute('app-mention-display-name')??node.getAttribute('data-keyword')??node.textContent?.trim();
      if(label!==name)continue;
      const raw=node.getAttribute('app-mention-path')??node.getAttribute('data-id')??node.getAttribute('href');
      if(!raw)continue;
      let id=raw.replace(/^app:\/\//,'').replace(/^plugin:/,'');
      if(!/^asdk_app_/.test(id)) {
        const url=new URL(raw,location.href);
        if(url.origin!==location.origin)continue;
        id=/^\/plugins\/plugin_(asdk_app_[A-Za-z0-9_]+)$/.exec(url.pathname)?.[1]??'';
      }
      if(/^asdk_app_[A-Za-z0-9_]{1,128}$/.test(id))ids.add(id);
    }
    return [...ids];
  },name);
  if(identities.length>1)throw selectorDrift("ChatGPT exposed conflicting connector App IDs");
  return identities[0];
}

export async function identifyConnectorApp(page:Page,connectorName:string,expectedAccountFingerprint:string,signal?:AbortSignal):Promise<string> {
  signal?.throwIfAborted();
  const observed=await observedConnectorApp(page,connectorName);
  if(observed)return observed;
  const current=new URL(page.url());
  if(current.origin!=="https://chatgpt.com"||current.pathname!=="/"||current.search)await page.goto("https://chatgpt.com/",{waitUntil:"domcontentloaded",timeout:30_000,signal});
  if((await readChatGptAccount(page)).fingerprint!==expectedAccountFingerprint)throw new BrowserCompanionError("ChatGPT account changed before connector maintenance", "authentication_required");
  const selection=await selectConnector(page,connectorName,signal);
  const mention=selection.composer.locator(SELECTED_CONNECTOR_SELECTOR).filter({visible:true});
  const identity=await mention.getAttribute("app-mention-path")||await mention.getAttribute("data-id");
  const appId=identity?.replace(/^app:\/\//,"").replace(/^plugin:/,"");
  if(!appId||!/^asdk_app_[A-Za-z0-9_]{1,128}$/.test(appId))throw selectorDrift("ChatGPT did not expose the selected connector's App ID");
  return appId;
}

async function connectorPage(page:Page,appId:string,account:string,permissions:boolean,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const url=`https://chatgpt.com/settings/plugins-settings/plugin_${appId}${permissions?'/permissions':''}`;
  const assertPage=async()=>{
    signal?.throwIfAborted();
    if(new URL(page.url()).origin!=="https://chatgpt.com"||new URL(page.url()).pathname!==new URL(url).pathname)throw selectorDrift("ChatGPT changed the plugin page during connector maintenance");
    if((await readChatGptAccount(page)).fingerprint!==account)throw selectorDrift("ChatGPT account changed during connector maintenance");
  };
  if(page.url()!==url)await page.goto(url,{waitUntil:"domcontentloaded",timeout:30_000,signal});
  await assertPage();
  return assertPage;
}

export async function setConnectorAllowAll(page:Page,appId:string,account:string,signal?:AbortSignal):Promise<boolean> {
  const assertPage=await connectorPage(page,appId,account,true,signal);
  return ensureAllowAll(page,assertPage,signal);
}

export type ConnectorRefreshObservation={url:string;wait:(signal?:AbortSignal)=>Promise<boolean>;dispose:()=>Promise<void>};
export async function beginConnectorToolRefresh(page:Page,appId:string,name:string,account:string,signal?:AbortSignal):Promise<ConnectorRefreshObservation> {
  traceRefresh("prepare refresh control");
  const assertPage=await connectorPage(page,appId,account,false,signal);
  // Settings can also contain a hidden app-name copy. Select visible text before
  // taking the first match, rather than waiting on that hidden copy.
  await page.getByText(name,{exact:true}).and(page.locator(':visible')).first().waitFor({state:"visible",timeout:5_000,signal});
  await markRefreshButton(page);
  const button=page.locator('button[data-refresh-tools-target="true"]');
  await assertPage();
  // A fast refresh may finish before click() returns. Record its loading
  // transition before clicking rather than requiring a later poll to catch it.
  await button.evaluate(node=>{
    const target=node as HTMLButtonElement;
    const host=window as typeof window & {__refreshWatch?:{observed:boolean;observer:MutationObserver;target:HTMLButtonElement;find:()=>HTMLButtonElement|undefined}};
    host.__refreshWatch?.observer.disconnect();
    const busy=()=>target.disabled||target.getAttribute('aria-disabled')==='true'||Boolean(target.querySelector('.animate-spin,[role="progressbar"],[data-state="loading"]'));
    const find=()=>{
      const candidates=new Set<HTMLButtonElement>();
      const direct=[...document.querySelectorAll<HTMLButtonElement>('button[data-testid*="refresh"],button[data-action="refresh-tools"],button[name="refresh_tools"]')].filter(button=>button.getClientRects().length>0);
      if(direct.length===1)return direct[0];
      for(const node of document.querySelectorAll('div,section')) {
        const buttons=[...node.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.getClientRects().length>0);
        if(buttons.length!==4)continue;
        const destructive=(button:HTMLButtonElement)=>{const color=getComputedStyle(button).color;const c=/^rgba?\(/.test(color)?color.match(/\d+/g)?.map(Number)||[]:[];return c.length>=3&&c[0]!>c[1]!*1.3&&c[0]!>c[2]!*1.3;};
        if(destructive(buttons[3]!)&&buttons.slice(0,3).every(button=>!destructive(button)))candidates.add(buttons[2]!);
      }
      return candidates.size===1?[...candidates][0]:undefined;
    };
    const watch={target,find,observed:busy(),observer:new MutationObserver(records=>{
      watch.observed ||= busy()||records.some(record=>record.type==='attributes'&&(
        record.attributeName==='disabled'&&record.oldValue!==null||record.attributeName==='aria-disabled'&&record.oldValue==='true'));
    })};
    host.__refreshWatch=watch;
    watch.observer.observe(target,{attributes:true,attributeOldValue:true,childList:true,subtree:true});
  });
  const progress=()=>page.evaluate(()=>{
    const watch=(window as typeof window & {__refreshWatch?:{observed:boolean;target:HTMLButtonElement;find:()=>HTMLButtonElement|undefined}}).__refreshWatch;
    if(!watch)return null;
    const target=watch.target.isConnected?watch.target:watch.find();
    const pending=!target||target.disabled||target.getAttribute('aria-disabled')==='true'||Boolean(target.querySelector('.animate-spin,[role="progressbar"],[data-state="loading"]'));
    watch.observed ||= Boolean(target&&pending);
    return {observed:watch.observed,pending,replaced:!watch.target.isConnected};
  });
  const url=page.url();
  const dispose=async()=>{
    if(page.isClosed()||page.url()!==url)return;
    await page.evaluate(()=>{
      const host=window as typeof window & {__refreshWatch?:{observer:MutationObserver}};
      host.__refreshWatch?.observer.disconnect();delete host.__refreshWatch;
    }).catch(()=>{});
  };
  try {
    traceRefresh("click refresh");await button.click({timeout:5_000,noWaitAfter:true,signal});
    traceRefresh("refresh click returned");
    return {url,dispose,wait:async signal=>{
      const deadline=Date.now()+60_000;let previous:string|undefined;
      while(Date.now()<deadline) {
        signal?.throwIfAborted();
        if(page.isClosed()||page.url()!==url)throw selectorDrift("Tool refresh was requested; its completion was not confirmed before another browser action changed pages");
        const state=await progress();
        if(!state)throw selectorDrift("Tool refresh was requested; its completion was not confirmed before ChatGPT reloaded the page");
        const summary=`loading ${state.observed?"observed":"unobserved"}, ${state.pending?"pending":"idle"}${state.replaced?", control replaced":""}`;
        if(summary!==previous){traceRefresh(summary);previous=summary;}
        if(state.observed&&!state.pending){traceRefresh("refresh completed");return true;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw selectorDrift("Tool refresh was requested, but ChatGPT did not finish it within 60 seconds");
    }};
  }catch(error){await dispose();throw error;}
}

export async function requestConnectorToolRefresh(page:Page,appId:string,name:string,account:string,signal?:AbortSignal):Promise<boolean> {
  const observation=await beginConnectorToolRefresh(page,appId,name,account,signal);
  try{return await observation.wait(signal);}finally{await observation.dispose();}
}

export async function verifyConnectorAllowAll(page:Page,appId:string,account:string,signal?:AbortSignal):Promise<void> {
  await connectorPage(page,appId,account,true,signal);
  if(!await (await allowAllChoice(page,signal)).checked())throw selectorDrift("Allow all tools was not confirmed after reloading plugin settings");
}

export async function connectorPermissionSummary(page:Page):Promise<{summary:string;allowAll:boolean}|null> {
  return page.evaluate(()=>{
    const candidates=new Set<Element>();
    const direct=[...document.querySelectorAll('[data-permission],[data-action="plugin-permissions"],a[href$="/permissions"]')].filter(node=>node.getClientRects().length>0);
    for(const node of direct)candidates.add(node);
    if(!candidates.size)for(const node of document.querySelectorAll('div,section')) {
      const controls=[...node.querySelectorAll('button,[role="button"]')].filter(button=>button.getClientRects().length>0);
      if(controls.length<5||controls[controls.length-2]!.getAttribute('data-refresh-tools-target')!=='true')continue;
      const destructive=(control:Element)=>{const c=getComputedStyle(control).color.match(/\d+/g)?.map(Number)||[];return c.length>=3&&c[0]!>c[1]!*1.3&&c[0]!>c[2]!*1.3;};
      const permission=controls[controls.length-5]!;
      const text=document.createTreeWalker(permission,NodeFilter.SHOW_TEXT);let leaves=0;
      while(text.nextNode())if(text.currentNode.textContent?.trim())leaves++;
      // Permission is the summary row immediately preceding the four Manage app
      // controls; its chevron/shield and separate label/value text distinguish it
      // from the plain Uninstall or View details buttons above it.
      if(destructive(controls.at(-1)!)&&!destructive(permission)&&permission.querySelector('svg')&&leaves>=2)candidates.add(permission);
    }
    if(candidates.size!==1)return null;
    const control=[...candidates][0]!;
    return {summary:(control.textContent??'').normalize('NFKC').replace(/\s+/g,' ').trim(),allowAll:control.getAttribute('data-permission')==='allow_all'};
  });
}

export type PermissionWitness={summary?:string;remember:(summary:string)=>void};
export async function inspectConnectorSettings(page:Page,appId:string,name:string,account:string,signal?:AbortSignal) {
  if(!/^asdk_app_[A-Za-z0-9_]{1,128}$/.test(appId))throw selectorDrift("Invalid connector App ID");
  traceRefresh("open settings");
  await connectorPage(page,appId,account,false,signal);
  traceRefresh("settings opened");
  await page.getByText(name,{exact:true}).and(page.locator(':visible')).first().waitFor({state:"visible",timeout:5_000,signal});
  traceRefresh("connector name visible");
  await markRefreshButton(page);
  return connectorPermissionSummary(page);
}

export async function prepareConnectorRefresh(page:Page,name:string,expectedAccountFingerprint?:string,signal?:AbortSignal,knownAppId?:string,witness?:PermissionWitness):Promise<{appId:string;permissionChanged:boolean;observation:ConnectorRefreshObservation}> {
  const account=expectedAccountFingerprint??(await readChatGptAccount(page)).fingerprint;
  const appId=knownAppId??await identifyConnectorApp(page,name,account,signal);
  const before=await inspectConnectorSettings(page,appId,name,account,signal);
  let permissionChanged=false;
  if(!before?.allowAll&&(!witness?.summary||before?.summary!==witness.summary)) {
    traceRefresh("permission needs selection");
    permissionChanged=await setConnectorAllowAll(page,appId,account,signal);
    await connectorPage(page,appId,account,false,signal);
    await page.getByText(name,{exact:true}).and(page.locator(':visible')).first().waitFor({state:"visible",timeout:5_000,signal});
    await markRefreshButton(page);
  }
  const verified=await connectorPermissionSummary(page);
  if(verified?.summary)witness?.remember(verified.summary);
  traceRefresh("permission allows all");
  const observation=await beginConnectorToolRefresh(page,appId,name,account,signal);
  return {appId,permissionChanged,observation};
}

export async function refreshConnectorTools(page:Page,name:string,expectedAccountFingerprint?:string,signal?:AbortSignal,knownAppId?:string,witness?:PermissionWitness):Promise<{appId:string;refreshObserved:boolean;permissionChanged:boolean;schemaVerified:false}> {
  const prepared=await prepareConnectorRefresh(page,name,expectedAccountFingerprint,signal,knownAppId,witness);
  try {
    const refreshObserved=await prepared.observation.wait(signal);
    return {appId:prepared.appId,refreshObserved,permissionChanged:prepared.permissionChanged,schemaVerified:false};
  }finally{await prepared.observation.dispose();}
}
