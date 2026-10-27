import type {BrowserContext, Page} from "patchright";
import {BrowserCompanionError,ConversationCooldownError} from "./errors";
import {AsyncLocalStorage} from "node:async_hooks";
import {canonicalChatGptConversationUrl} from "./protocol";

const cooldownBypass = new AsyncLocalStorage<boolean>();
export function withConversationCooldownBypass<T>(allowed:boolean, operation:()=>Promise<T>):Promise<T> {
  return cooldownBypass.run(allowed,operation);
}

// One budget for the shared browser, including returns from account settings.
const defaultTimings = {
  conversationLoadIntervalSeconds:180,
  conversationUnavailableCooldownSeconds:300,
  rateLimitCooldownSeconds:180,
};
let timings = {...defaultTimings};

// Set once at startup from the server's validated settings, before any loads.
export function configureNavigationTimings(raw?:string):void {
  const supplied:unknown=raw===undefined?{}:JSON.parse(raw);
  if(!supplied||typeof supplied!=="object"||Array.isArray(supplied))throw new Error("Invalid browser navigation timings");
  const next={...defaultTimings};
  for(const key of Object.keys(next) as (keyof typeof next)[]){
    const value=(supplied as Record<string,unknown>)[key]??next[key];
    if(typeof value!=="number"||!Number.isInteger(value)||value<1||value>86_400)throw new Error(`Invalid browser navigation timing: ${key}`);
    next[key]=value;
  }
  timings=next;
}
type Budget = {lastLoad:number|null; blockedUntil:number; unavailableUntil:number|null; tail:Promise<void>};
const budgets = new WeakMap<BrowserContext,Budget>();

function navigationBudget(context:BrowserContext):Budget {
  let budget=budgets.get(context);
  if(!budget){budget={lastLoad:null,blockedUntil:0,unavailableUntil:null,tail:Promise.resolve()};budgets.set(context,budget);}
  return budget;
}

function isConversationUrl(url:URL):boolean {
  return url.origin === "https://chatgpt.com" && /^\/(?:g\/[^/]+\/)?c\/[^/]+\/?$/.test(url.pathname);
}

export function conversationLoadAvailableAt(page:Page,url:string):number|null {
  const target=new URL(url);
  if(!isConversationUrl(target))return null;
  try {if(canonicalChatGptConversationUrl(page.url())===canonicalChatGptConversationUrl(url))return null;} catch {}
  const budget=budgets.get(page.context());
  if(!budget)return null;
  const at=Math.max(budget.unavailableUntil??0,budget.blockedUntil,budget.lastLoad===null?0:budget.lastLoad+timings.conversationLoadIntervalSeconds*1_000);
  return at>Date.now()?at:null;
}

export function recordConversationUnavailable(page:Page):void {
  const budget=navigationBudget(page.context());
  // Repeated health checks of the same failure must not postpone recovery.
  budget.unavailableUntil??=Date.now()+timings.conversationUnavailableCooldownSeconds*1_000;
}

// Called only after verifying the account and a usable conversation composer.
export function recordConversationAvailable(page:Page):void {
  if(isConversationUrl(new URL(page.url()))){
    const budget=budgets.get(page.context());
    if(budget)budget.unavailableUntil=null;
  }
}

export function isChatGptPage(value:string):boolean {
  try {return new URL(value).origin === "https://chatgpt.com";} catch {return false;}
}

export async function navigatePage(page:Page,url:string,options:{signal?:AbortSignal;timeout?:number;reload?:boolean}={}):Promise<void> {
  options.signal?.throwIfAborted();
  const target = new URL(url);
  if(target.protocol !== "https:")throw new Error("Browser window navigation requires HTTPS");
  if(!options.reload && page.url() === target.href)return;
  const budget = navigationBudget(page.context());
  const previous = budget.tail;
  let release!:()=>void;
  budget.tail = new Promise<void>(resolve=>{release=resolve;});
  try {
    await previous;
    options.signal?.throwIfAborted();
    if(!options.reload && page.url() === target.href)return;
    const sourceUrl=page.url();
    const conversation = isConversationUrl(target);
    if(conversation&&!cooldownBypass.getStore()){
      const availableAt=Math.max(budget.unavailableUntil??0,budget.blockedUntil,budget.lastLoad===null?0:budget.lastLoad+timings.conversationLoadIntervalSeconds*1_000);
      if(availableAt>Date.now())throw new ConversationCooldownError(Math.min(availableAt,Number.MAX_SAFE_INTEGER));
      options.signal?.throwIfAborted();
    }
    if(page.url()!==sourceUrl)throw new BrowserCompanionError("ChatGPT changed pages while waiting to navigate", "external_interference");
    if(options.reload&&page.url()!==target.href)throw new BrowserCompanionError("ChatGPT changed pages before recovery reload", "external_interference");
    if(conversation){
      budget.lastLoad=Date.now();
      // Reserve the next slot before loading so even a timeout or another
      // queued chat cannot start a second probe within the shared cooldown.
      if(budget.unavailableUntil!==null)budget.unavailableUntil=Date.now()+timings.conversationUnavailableCooldownSeconds*1_000;
    }
    const settings={waitUntil:"domcontentloaded" as const,timeout:options.timeout??60_000,signal:options.signal};
    const response=options.reload?await page.reload(settings):await page.goto(target.href,settings);
    if(response?.status()===429){
      const retryAfter=await response.headerValue("retry-after");
      const retryAfterMs=retryAfter?.trim()&&/^\d+$/.test(retryAfter.trim())?Number(retryAfter.trim())*1_000:Date.parse(retryAfter??"")-Date.now();
      if(conversation)budget.blockedUntil=Math.max(budget.blockedUntil,Date.now()+Math.max(timings.conversationLoadIntervalSeconds*1_000,Number.isFinite(retryAfterMs)&&retryAfterMs>=0?retryAfterMs:timings.rateLimitCooldownSeconds*1_000));
      throw new BrowserCompanionError("ChatGPT conversation loading is temporarily rate limited; wait before retrying", "rate_limited");
    }
  }finally{release();}
}
