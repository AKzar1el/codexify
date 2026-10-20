import {setTimeout as delay} from "node:timers/promises";
import type {BrowserContext, Page} from "patchright";
import {BrowserCompanionError} from "./errors";

// One budget for the shared browser, including returns from account settings.
const CONVERSATION_SPACING_MS = 3_000;
const RATE_LIMIT_COOLDOWN_MS = 180_000;
type Budget = {lastLoad:number|null; blockedUntil:number; tail:Promise<void>};
const budgets = new WeakMap<BrowserContext,Budget>();

export function isChatGptPage(value:string):boolean {
  try {return new URL(value).origin === "https://chatgpt.com";} catch {return false;}
}

export async function navigatePage(page:Page,url:string,options:{signal?:AbortSignal;timeout?:number;reload?:boolean}={}):Promise<void> {
  options.signal?.throwIfAborted();
  const target = new URL(url);
  if(target.protocol !== "https:")throw new Error("Browser window navigation requires HTTPS");
  if(!options.reload && page.url() === target.href)return;
  const context = page.context();
  let budget = budgets.get(context);
  if(!budget){budget={lastLoad:null,blockedUntil:0,tail:Promise.resolve()};budgets.set(context,budget);}
  const previous = budget.tail;
  let release!:()=>void;
  budget.tail = new Promise<void>(resolve=>{release=resolve;});
  try {
    await previous;
    options.signal?.throwIfAborted();
    if(!options.reload && page.url() === target.href)return;
    const sourceUrl=page.url();
    const conversation = target.origin === "https://chatgpt.com" && /^\/(?:g\/[^/]+\/)?c\/[^/]+\/?$/.test(target.pathname);
    if(conversation){
      if(Date.now()<budget.blockedUntil)throw new BrowserCompanionError("ChatGPT conversation loading is temporarily rate limited; wait before retrying", "rate_limited");
      if(budget.lastLoad!==null){
        const remaining = budget.lastLoad + CONVERSATION_SPACING_MS - Date.now();
        if(remaining>0)await delay(remaining,undefined,{signal:options.signal});
      }
      options.signal?.throwIfAborted();
    }
    if(page.url()!==sourceUrl)throw new BrowserCompanionError("ChatGPT changed pages while waiting to navigate", "external_interference");
    if(options.reload&&page.url()!==target.href)throw new BrowserCompanionError("ChatGPT changed pages before recovery reload", "external_interference");
    if(conversation)budget.lastLoad=Date.now();
    const settings={waitUntil:"domcontentloaded" as const,timeout:options.timeout??60_000,signal:options.signal};
    const response=options.reload?await page.reload(settings):await page.goto(target.href,settings);
    if(response?.status()===429){
      const retryAfter=await response.headerValue("retry-after");
      const retryAfterMs=retryAfter?.trim()&&/^\d+$/.test(retryAfter.trim())?Number(retryAfter.trim())*1_000:Date.parse(retryAfter??"")-Date.now();
      if(conversation)budget.blockedUntil=Math.max(budget.blockedUntil,Date.now()+(Number.isFinite(retryAfterMs)&&retryAfterMs>=0?Math.max(CONVERSATION_SPACING_MS,retryAfterMs):RATE_LIMIT_COOLDOWN_MS));
      throw new BrowserCompanionError("ChatGPT conversation loading is temporarily rate limited; wait before retrying", "rate_limited");
    }
  }finally{release();}
}
