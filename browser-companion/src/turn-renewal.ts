import type {Page} from "patchright";
import {canonicalChatGptConversationUrl} from "./protocol";
import {readChatGptAccount} from "./account";
import {readTurnDomState} from "./turn-binding";
import {chatGptAssistantTurnSelector} from "./session";
import {responseDomSnapshot} from "./response-observer";

export function handoffReportReady(input:{answer:string;responsePresent:boolean;generationRunning:boolean;completionActionVisible:boolean}, id:string):boolean {
  return /^renew-[a-f0-9]{64}$/.test(id) && input.responsePresent && !input.generationRunning
    && input.completionActionVisible && input.answer.trimStart().startsWith(`Turn handoff ${id}\n`)
    && input.answer.trim().length > `Turn handoff ${id}`.length;
}

// Read-only, same-account, same-conversation proof. Never interpret companion idle,
// missing Stop controls alone, old answers or a streaming report as completion.
export async function completedHandoff(page:Page, url:string, account:string, id:string, signal?:AbortSignal):Promise<boolean> {
  let previous:string|undefined;
  let identity:string|undefined;
  for(let attempt=0;attempt<2;attempt++) {
    signal?.throwIfAborted();
    if(canonicalChatGptConversationUrl(page.url())!==canonicalChatGptConversationUrl(url)
      ||(await readChatGptAccount(page)).fingerprint!==account)return false;
    const state=await readTurnDomState(page);
    const last=state.responseIdentities.at(-1);
    if(!last || state.generationRunning)return false;
    const snapshot=await responseDomSnapshot(page.locator(chatGptAssistantTurnSelector(last)));
    if(!handoffReportReady({answer:snapshot.visibleText,...snapshot,generationRunning:state.generationRunning},id))return false;
    if(attempt===1)return last===identity && snapshot.visibleText===previous;
    identity=last;previous=snapshot.visibleText;
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(signal?.reason??new Error("Cancelled"));};
      const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},750);
      signal?.addEventListener("abort",abort,{once:true});
    });
  }
  return false;
}
