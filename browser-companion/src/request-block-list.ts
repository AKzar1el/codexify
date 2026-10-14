import {createHash} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {join,dirname} from "node:path";
import type {BrowserContext} from "patchright";

export function parseRequestBlockList(raw:string|undefined):string[] {
  let value:unknown;
  try{value=raw===undefined?[]:JSON.parse(raw);}catch{throw new Error("Browser request block list must be a JSON array");}
  if(!Array.isArray(value)||value.length>128)throw new Error("Browser request block list must contain at most 128 patterns");
  for(let index=0;index<value.length;index++)if(typeof value[index]!=="string"||!/^[\x20-\x7e]{1,4096}$/.test(value[index]))throw new Error(`Browser request block list entry ${index} must be 1 to 4096 printable ASCII characters`);
  return value as string[];
}

export const REQUEST_RESOURCE_TYPES=["main_frame","sub_frame","stylesheet","script","image","font","object","xmlhttprequest","ping","csp_report","media","websocket","webtransport","webbundle","other"];

export async function prepareRequestBlockList(profilePath:string,patterns:readonly string[]) {
  if(!patterns.length)return undefined;
  parseRequestBlockList(JSON.stringify(patterns));
  const fingerprint=createHash("sha256").update(JSON.stringify(patterns)).digest("hex");
  // A different list gets a different unpacked-extension identity, preventing old
  // cached rules or service-worker code from being reused for a changed policy.
  const path=join(dirname(profilePath),"request-block-lists",fingerprint);
  await mkdir(path,{recursive:true,mode:0o700});
  const rules=patterns.map((regexFilter,index)=>({id:index+1,priority:1,action:{type:"block"},condition:{regexFilter,isUrlFilterCaseSensitive:true,resourceTypes:REQUEST_RESOURCE_TYPES}}));
  const manifest={manifest_version:3,name:"Codexify request block list",version:"1.0.0",permissions:["declarativeNetRequest"],background:{service_worker:"request-policy.js"},declarative_net_request:{rule_resources:[{id:"startup_guard",enabled:true,path:"rules.json"}]}};
  const script=`chrome.runtime.onStartup.addListener(()=>{});
globalThis.codexifyRequestPolicyReady=(async()=>{
 const patterns=${JSON.stringify(patterns)};
 for(let index=0;index<patterns.length;index++){
  const result=await chrome.declarativeNetRequest.isRegexSupported({regex:patterns[index],isCaseSensitive:true,requireCapturing:false});
  if(!result.isSupported)return {ok:false,error:'requestBlockList['+index+'] is not supported by Chromium RE2 ('+result.reason+')'};
 }
 const rules=${JSON.stringify(rules)};
 const previous=await chrome.declarativeNetRequest.getDynamicRules();
 await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:previous.map(rule=>rule.id),addRules:rules});
 const installed=await chrome.declarativeNetRequest.getDynamicRules();
 if(installed.length!==rules.length||rules.some(expected=>!installed.some(actual=>actual.id===expected.id&&actual.action.type==='block'&&actual.condition.regexFilter===expected.condition.regexFilter&&actual.condition.isUrlFilterCaseSensitive===true)))return {ok:false,error:'Chromium did not confirm the request block list'};
 await chrome.declarativeNetRequest.updateEnabledRulesets({disableRulesetIds:['startup_guard']});
 return {ok:true,fingerprint:${JSON.stringify(fingerprint)},count:patterns.length};
})().catch(()=>({ok:false,error:'Chromium could not install the request block list'}));`;
  await Promise.all([
    writeFile(join(path,"manifest.json"),JSON.stringify(manifest),{mode:0o600}),
    writeFile(join(path,"rules.json"),JSON.stringify([{id:1,priority:1,action:{type:"block"},condition:{regexFilter:"^https?://",resourceTypes:REQUEST_RESOURCE_TYPES}}]),{mode:0o600}),
    writeFile(join(path,"request-policy.js"),script,{mode:0o600}),
  ]);
  return {path,fingerprint,count:patterns.length};
}

export function requestBlockListArgs(args:readonly string[],policy:Awaited<ReturnType<typeof prepareRequestBlockList>>):string[] {
  if(!policy)return [...args];
  return [...args.filter(arg=>arg!=="--disable-extensions"),`--disable-extensions-except=${policy.path}`,`--load-extension=${policy.path}`];
}

export async function verifyRequestBlockList(context:BrowserContext,policy:Awaited<ReturnType<typeof prepareRequestBlockList>>):Promise<void> {
  if(!policy)return;
  const matches=(worker:{url():string})=>worker.url().startsWith("chrome-extension://")&&worker.url().endsWith("/request-policy.js");
  const worker=context.serviceWorkers().find(matches)||await context.waitForEvent("serviceworker",{predicate:matches,timeout:15_000});
  const result=await worker.evaluate(async()=>await (globalThis as any).codexifyRequestPolicyReady);
  if(result?.ok!==true||result.fingerprint!==policy.fingerprint||result.count!==policy.count)throw new Error(result?.error||"Chromium request block list verification failed");
}
