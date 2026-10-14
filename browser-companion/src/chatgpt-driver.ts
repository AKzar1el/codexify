import type { Locator, Page } from "patchright";
import {classifyPlan,readBillingPlan,identifyConnectorApp,observedConnectorApp,inspectConnectorSettings,setConnectorAllowAll,verifyConnectorAllowAll,beginConnectorToolRefresh,type ConnectorRefreshObservation,type AccountPlan} from "./account-settings";
import {ConnectorAppCache} from "./connector-cache";
import {openNewChat, createdChatUrl, assertNewChatDraft} from "./new-chat";
import { HealthAccountCache, readChatGptAccount, type ChatGptAccount } from "./account";
import { throwIfSessionAttention, toolApprovalVisible } from "./browser-session";
import type { BrowserDriver, DriverExecution, BrowserStepRunner } from "./browser-window";
import { activeComposer, composerText, insertExactPrompt, isPairingVerificationDraft, uniqueSendButton } from "./composer";
import { clearComposerState, connectorIsSelected, SELECTED_CONNECTOR_SELECTOR, selectConnector, type SelectedConnector } from "./connector-selection";
import { asCompanionError, BrowserCompanionError } from "./errors";
import { assertSelectedModelAndEffort, selectModelAndEffort } from "./model-selection";
import { selectPairingMedium, type PairingMediumSelection } from "./pairing-model";
import { buildCapabilityCatalog, type AccountCapabilities } from "./models";
import { canonicalChatGptConversationUrl, validateChatGptConversationUrl, type CapabilityCatalog, type ExecuteActionRequest } from "./protocol";
import {
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  assertAuthenticatedChatGptPage,
  detectChatGptAccountCapabilities,
} from "./session";
import {
  captureSubmissionBaseline,
  waitForSubmissionAcceptance,
} from "./turn-binding";

export interface SingleBrowserSurface {
  page(): Promise<Page>;
  navigate(url: string, signal?: AbortSignal): Promise<Page>;
  reveal(): Promise<void>;
  beginAction(): Promise<void>;
  endAction(): Promise<void>;
  close(): Promise<void>;
}


export function responseCompletionReady(input: {
  responsePresent:boolean;
  generationRunning:boolean;
  answer:string;
  completionActionVisible:boolean;
}): boolean {
  return input.responsePresent
    && !input.generationRunning
    && input.answer.length > 0
    && input.completionActionVisible;
}

async function generationRunning(page: Page): Promise<boolean> {
  return page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible:true }).count()
    .then(count => count > 0)
    .catch(() => false);
}

async function clearExistingDraft(page:Page,signal?:AbortSignal):Promise<Locator> {
  const composer=await activeComposer(page,30_000,signal);
  const hasDraft=await composer.evaluate(element=>{
    if(element instanceof HTMLTextAreaElement||element instanceof HTMLInputElement)return element.value.length>0;
    const clone=element.cloneNode(true) as HTMLElement;
    for(const chip of clone.querySelectorAll('[contenteditable="false"],[app-mention-path],[data-id^="plugin:"]'))chip.remove();
    return (clone.textContent??'').length>0;
  });
  if(!hasDraft)return composer;
  signal?.throwIfAborted();
  await clearComposerState(page,"",signal);
  return activeComposer(page,30_000,signal);
}

async function stopLingeringResponse(
  page: Page,
  signal: AbortSignal,
  expected: { canonicalUrl:string; accountFingerprint:string },
): Promise<void> {
  if (signal.aborted) throw new DOMException("Browser action aborted", "AbortError");
  if (!await generationRunning(page)) return;
  const deadline = Date.now() + 7_500;
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(7_500)]);
  const timeout = (limit:number) => Math.max(1, Math.min(limit, deadline - Date.now()));
  const assertTarget = async () => {
    await throwIfSessionAttention(page);
    await assertAuthenticatedChatGptPage(page);
    if (canonicalChatGptConversationUrl(page.url()) !== expected.canonicalUrl) {
      throw new BrowserCompanionError("ChatGPT changed conversations while stopping the previous response", "conversation_unavailable");
    }
    if ((await readChatGptAccount(page)).fingerprint !== expected.accountFingerprint) {
      throw new BrowserCompanionError("ChatGPT account changed while stopping the previous response", "authentication_required");
    }
  };
  let lastError:unknown;
  for (let attempt = 0; attempt < 3 && !boundedSignal.aborted; attempt++) {
    await assertTarget();
    if (boundedSignal.aborted) break;
    const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible:true });
    const count = await stop.count();
    if (count === 0) return;
    if (count !== 1) {
      throw new BrowserCompanionError("ChatGPT does not have one visible Stop control", "selector_drift");
    }
    try {
      if (await stop.isEnabled()) await stop.click({ timeout:timeout(750), signal:boundedSignal });
      await stop.waitFor({ state:"hidden", timeout:timeout(1_000), signal:boundedSignal });
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
    if (attempt === 1 && !boundedSignal.aborted) {
      // Rehydrate a stuck Stop control only before inserting our prompt.
      await assertTarget();
      let composer:Locator;
      try {
        composer = await activeComposer(page, timeout(1_000), boundedSignal);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        break;
      }
      if ((await composerText(composer)).trim()) {
        await clearExistingDraft(page,boundedSignal);
      }
      try {
        await page.reload({ waitUntil:"domcontentloaded", timeout:timeout(2_000), signal:boundedSignal });
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        break;
      }
    }
  }
  if (signal.aborted) throw new DOMException("Browser action aborted", "AbortError");
  throw new BrowserCompanionError(
    "ChatGPT did not stop the previous response; the new message was not sent",
    "selector_drift",
    { cause:lastError },
  );
}

async function exactConversationPage(
  surface: SingleBrowserSurface,
  requestedUrl: string,
  expectedUrl: string,
  signal?: AbortSignal,
): Promise<{ page:Page; canonicalUrl:string }> {
  validateChatGptConversationUrl(requestedUrl);
  validateChatGptConversationUrl(expectedUrl);
  const page = await surface.navigate(requestedUrl, signal);
  await throwIfSessionAttention(page);
  try {
    await assertAuthenticatedChatGptPage(page);
  } catch (error) {
    throw new BrowserCompanionError(
      "ChatGPT authentication could not be verified for the paired conversation",
      "authentication_required",
      { cause:error },
    );
  }
  const canonicalUrl = canonicalChatGptConversationUrl(page.url());
  if (canonicalUrl !== canonicalChatGptConversationUrl(expectedUrl)) {
    throw new BrowserCompanionError(
      "ChatGPT navigated to a different conversation than the explicitly paired URL",
      "conversation_unavailable",
    );
  }
  return { page, canonicalUrl };
}

export class ChatGptBrowserDriver implements BrowserDriver {
  private readonly healthAccount = new HealthAccountCache();
  private maintenance?: {page:Page;account:ChatGptAccount};
  private pendingRefresh?: {page:Page;url:string;account:ChatGptAccount};
  private pendingSubmission?: {actionId:string;mayHaveSent:boolean};
  private planCache?: {epoch:string;plan:AccountPlan};
  private capabilitiesCache?: {
    accountFingerprint:string;
    capabilities:AccountCapabilities;
    catalog:CapabilityCatalog;
  };

  private readonly connectorApps:ConnectorAppCache;
  constructor(private readonly surface: SingleBrowserSurface, private readonly build: string,connectorCachePath?:string) {
    this.connectorApps=new ConnectorAppCache(connectorCachePath);
  }

  async health(): Promise<{
    authenticated:boolean;
    accountFingerprint:string | null;
    status:"idle" | "busy" | "authentication_required" | "unavailable";
    detail:string | null;
  }> {
    try {
      const page = await this.surface.page();
      if (this.maintenance?.page === page) {
        return {authenticated:true,accountFingerprint:this.maintenance.account.fingerprint,
          status:"busy",detail:"The shared ChatGPT tab is performing account maintenance"};
      }
      if(this.pendingRefresh?.page===page&&page.url()===this.pendingRefresh.url) {
        return {authenticated:true,accountFingerprint:this.pendingRefresh.account.fingerprint,status:"idle",detail:null};
      }
      try {
        await assertAuthenticatedChatGptPage(page);
      } catch (error) {
        if (page.isClosed()) throw new BrowserCompanionError("The shared Chrome ChatGPT window was closed", "external_interference", {cause:error});
        throw new BrowserCompanionError(
          "ChatGPT authentication could not be verified in the shared browser window",
          "authentication_required",
          { cause:error },
        );
      }
      const account = await this.healthAccount.read(page);
      try {
        await throwIfSessionAttention(page);
      } catch (error) {
        if (error instanceof BrowserCompanionError && error.code === "authentication_required") {
          this.healthAccount.invalidate();
          return {
            authenticated:false,
            accountFingerprint:null,
            status:"authentication_required",
            detail:error.message,
          };
        }
        return {
          authenticated:true,
          accountFingerprint:account.fingerprint,
          status:"unavailable",
          detail:asCompanionError(error).message,
        };
      }
      const composer = await activeComposer(page, 2_000).catch(() => null);
      if (!composer) {
        return {
          authenticated:true,
          accountFingerprint:account.fingerprint,
          status:"unavailable",
          detail:"The shared ChatGPT window has no unique usable composer",
        };
      }
      return {
        authenticated:true,
        accountFingerprint:account.fingerprint,
        status:"idle",
        detail:null,
      };
    } catch (error) {
      const failure = asCompanionError(error);
      const authenticationRequired = failure.code === "authentication_required";
      if (authenticationRequired) this.healthAccount.invalidate();
      return {
        authenticated:false,
        accountFingerprint:null,
        status:authenticationRequired ? "authentication_required" : "unavailable",
        detail:failure.message,
      };
    }
  }

  async login(signal?:AbortSignal): Promise<{
    authenticated:boolean;
    accountFingerprint:string | null;
    status:"idle" | "busy" | "authentication_required" | "unavailable";
    detail:string | null;
  }> {
    this.planCache=undefined;
    this.healthAccount.invalidate();
    await this.surface.navigate("https://chatgpt.com/",signal);
    await this.surface.reveal();
    return this.health();
  }

  async prepareNewChat(projectUrl:string | null, signal?:AbortSignal): Promise<CapabilityCatalog> {
    await this.surface.beginAction();
    try { await openNewChat(this.surface, projectUrl,signal); return await this.capabilities(signal); }
    finally { await this.surface.endAction(); }
  }

  async capabilities(signal?:AbortSignal): Promise<CapabilityCatalog> {
    signal?.throwIfAborted();
    let page = await this.surface.page();
    if (new URL(page.url()).origin !== "https://chatgpt.com") {
      page = await this.surface.navigate("https://chatgpt.com/",signal);
    }
    await throwIfSessionAttention(page);
    try {
      await assertAuthenticatedChatGptPage(page);
    } catch (error) {
      throw new BrowserCompanionError("Sign in to ChatGPT before refreshing browser capabilities", "authentication_required", { cause:error });
    }
    const account = await readChatGptAccount(page);
    await clearExistingDraft(page,signal);
    const capabilities = await detectChatGptAccountCapabilities(page,{signal});
    const planKind = this.planCache?.plan.accountFingerprint === account.fingerprint
      ? this.planCache.plan.kind : classifyPlan(account.planType).kind;
    const catalog = buildCapabilityCatalog(capabilities, account.fingerprint, this.build, planKind);
    this.capabilitiesCache = { accountFingerprint:account.fingerprint, capabilities, catalog };
    return catalog;
  }

  async accountPlan(epoch:string, signal?:AbortSignal):Promise<AccountPlan> {
    signal?.throwIfAborted();
    const main=await this.surface.page(),account=await readChatGptAccount(main);
    if(this.planCache?.epoch===epoch&&this.planCache.plan.accountFingerprint===account.fingerprint)return this.planCache.plan;
    return this.withMaintenancePage(main,account,async page=>{
      const plan=await readBillingPlan(page,signal);
      if(plan.accountFingerprint!==account.fingerprint)throw new Error("ChatGPT account changed during plan inspection");
      this.planCache={epoch,plan};return plan;
    },signal);
  }

  async refreshConnector(name:string, signal?:AbortSignal) {
    return this.refreshConnectorSteps(name,async(operation,parent)=>operation(parent??new AbortController().signal),signal);
  }

  async refreshConnectorSteps(name:string,run:BrowserStepRunner,signal?:AbortSignal) {
    if(this.pendingRefresh)throw new BrowserCompanionError("Browser companion is busy with a connector refresh");
    let expectedAccount:string|undefined;
    const step = <T>(label:string,operation:(page:Page,account:ChatGptAccount,signal:AbortSignal)=>Promise<T>,maintenance=true)=>run(async operationSignal=>{
      operationSignal.throwIfAborted();
      const page=await this.surface.page(),account=await readChatGptAccount(page);
      if(expectedAccount&&expectedAccount!==account.fingerprint)throw new BrowserCompanionError("ChatGPT account changed during connector maintenance","authentication_required");
      expectedAccount=account.fingerprint;
      return maintenance?this.withMaintenancePage(page,account,main=>operation(main,account,operationSignal),operationSignal):operation(page,account,operationSignal);
    },signal).catch(error=>{
      const failure=asCompanionError(error);
      throw new BrowserCompanionError(`${label}: ${failure.message}`,failure.code,{cause:error});
    });
    const appId=await step("Identify connector",async(page,account,signal)=>{
      const cached=this.connectorApps.get(account.fingerprint,name);
      if(cached)return cached;
      const discovered=await observedConnectorApp(page,name)??await this.withMaintenancePage(page,account,main=>identifyConnectorApp(main,name,account.fingerprint,signal),signal);
      this.connectorApps.remember(account.fingerprint,name,discovered);return discovered;
    },false);
    if(this.pendingRefresh)throw new BrowserCompanionError("Browser companion is busy with a connector refresh");
    let originalUrl!:string;
    let pending:{page:Page;url:string;account:ChatGptAccount}|undefined;
    let observation:ConnectorRefreshObservation|undefined;
    const phase=<T>(label:string,operation:(page:Page,account:ChatGptAccount,signal:AbortSignal)=>Promise<T>)=>step(label,async(page,account,operationSignal)=>{
      if(this.pendingRefresh&&this.pendingRefresh!==pending)throw new BrowserCompanionError("Browser companion is busy with another connector refresh");
      if(pending&&(pending.page!==page||pending.url!==page.url()))throw new BrowserCompanionError("Another browser action changed pages during connector refresh","external_interference");
      if(!pending)originalUrl=page.url();
      const result=await this.withMaintenancePage(page,account,main=>operation(main,account,operationSignal),operationSignal,false);
      pending={page,url:page.url(),account};this.pendingRefresh=pending;
      return result;
    },false);
    const waitSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(60_000);
    let onAbort!:()=>void;
    const interrupted=new Promise<never>((_,reject)=>{
      onAbort=()=>reject(new BrowserCompanionError(signal?.aborted?"Refresh observation cancelled":"Tool refresh completion was not confirmed within 60 seconds",signal?.aborted?"cancelled":"failed"));
      if(waitSignal.aborted)onAbort();else waitSignal.addEventListener("abort",onAbort,{once:true});
    });
    void interrupted.catch(()=>{}); // Cancellation during preparation is handled by its bounded phase.
    try {
      const before=await phase("Inspect connector settings",(page,account,operationSignal)=>inspectConnectorSettings(page,appId,name,account.fingerprint,operationSignal));
      const knownSummary=this.connectorApps.getAllowAllSummary(expectedAccount!,name);
      const needsVerification=!before?.allowAll&&(!knownSummary||before?.summary!==knownSummary);
      let permissionChanged=false;
      if(needsVerification)permissionChanged=await phase("Verify connector permission",(page,account,operationSignal)=>setConnectorAllowAll(page,appId,account.fingerprint,operationSignal));
      observation=await phase("Start connector refresh",async(page,account,operationSignal)=>{
        if(needsVerification)await verifyConnectorAllowAll(page,appId,account.fingerprint,operationSignal);
        const current=await inspectConnectorSettings(page,appId,name,account.fingerprint,operationSignal);
        if(!needsVerification&&!current?.allowAll&&(!knownSummary||current?.summary!==knownSummary))throw new BrowserCompanionError("Connector permission changed before refresh","external_interference");
        if(current?.summary)this.connectorApps.rememberAllowAllSummary(account.fingerprint,name,current.summary);
        return beginConnectorToolRefresh(page,appId,name,account.fingerprint,operationSignal);
      });
      // Waiting on this refresh's result performs no UI work and owns no lease.
      // Other browser actions may navigate normally; the observer then stops.
      const refreshObserved=await Promise.race([observation.wait(waitSignal),interrupted]);
      return {appId,permissionChanged,refreshObserved,schemaVerified:false as const};
    }finally {
      waitSignal.removeEventListener("abort",onAbort);
      // Restore only if the shared page is still ours. Never undo another
      // action's navigation or overwrite a draft typed while refresh waited.
      try {await run(async operationSignal=>{
        const page=await this.surface.page();
        if(!pending||page!==pending.page||page.url()!==pending.url)return;
        await observation?.dispose();
        if(await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({visible:true}).count())return;
        await this.surface.beginAction();
        try{await this.surface.navigate(originalUrl,operationSignal);}finally{await this.surface.endAction();}
      });}catch(error){
        // An intervening submission can own the page while observation ends.
        if(!(error instanceof Error&&error.message.toLowerCase().includes("busy")))throw error;
      }finally{if(this.pendingRefresh===pending)this.pendingRefresh=undefined;}
    }
  }

  private async withMaintenancePage<T>(page:Page,account:ChatGptAccount,operation:(page:Page)=>Promise<T>,signal?:AbortSignal,restore=true):Promise<T> {
    signal?.throwIfAborted();
    await this.surface.beginAction();
    const previousUrl=page.url();
    let started=false;
    let completed=false;
    try {
      await throwIfSessionAttention(page);
      // Ownership tracks our UI operation, never ChatGPT's response lifetime.
      const composers=page.locator(CHATGPT_COMPOSER_SELECTOR).filter({visible:true});
      const count=await composers.count();
      if(count>1||count===0&&!new URL(previousUrl).pathname.startsWith('/settings/'))throw new BrowserCompanionError("Browser companion is busy; the shared composer is not ready");
      if(await this.surface.page()!==page||page.url()!==previousUrl)throw new BrowserCompanionError("ChatGPT changed pages before account maintenance", "external_interference");
      this.maintenance={page,account};started=true;
      signal?.throwIfAborted();
      if(count===1)await clearExistingDraft(page,signal);
      const result=await operation(page);completed=true;return result;
    } finally {
      try {
        if(started&&(restore||!completed))await this.surface.navigate(previousUrl,AbortSignal.timeout(signal?.aborted?1_500:5_000));
      } finally {
        this.maintenance=undefined;
        await this.surface.endAction();
      }
    }
  }

  async reveal(url: string | null, signal?:AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (url) await this.surface.navigate(url,signal);
    await this.surface.reveal();
  }

  async replacePairingDraft(request: ExecuteActionRequest, signal?:AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (request.prompt.kind !== "pair_verify") return false;
    const page = await this.surface.page();
    if (canonicalChatGptConversationUrl(page.url()) !== canonicalChatGptConversationUrl(request.expectedUrl)
      || await generationRunning(page) || await toolApprovalVisible(page)) return false;
    const account = await readChatGptAccount(page);
    if (account.fingerprint !== request.expectedAccountFingerprint) return false;
    const composer = await activeComposer(page, 2_000);
    if (!isPairingVerificationDraft(await composerText(composer))
      || await composer.locator(SELECTED_CONNECTOR_SELECTOR).filter({ visible:true }).count() !== 1) return false;
    await clearComposerState(page, request.connectorName);
    return true;
  }

  async execute(execution: DriverExecution): Promise<void> {
    execution.signal.throwIfAborted();
    this.pendingSubmission={actionId:execution.request.actionId,mayHaveSent:false};
    await this.surface.beginAction();
    let sendActivated = false;
    let sendAccepted = false;
    let ownedPage: Page | undefined;
    let insertionAttempted = false;
    let selectedConnector: SelectedConnector | undefined;
    let pairingSelection: PairingMediumSelection | undefined;
    let restoreUrl: string | undefined;
    try {
      execution.emit({ type:"navigating" });
      const creating = execution.request.prompt.kind === "create_chat";
      const opened = creating ? await openNewChat(this.surface, execution.request.url === "https://chatgpt.com/new" ? null : execution.request.url, execution.signal) : null;
      const exact = opened ? {page:opened, canonicalUrl:opened.url()} : await exactConversationPage(this.surface, execution.request.url, execution.request.expectedUrl, execution.signal);
      const page = exact.page;
      let canonicalUrl = exact.canonicalUrl;
      restoreUrl = canonicalUrl;
      const account = await readChatGptAccount(page);
      if (account.fingerprint !== execution.request.expectedAccountFingerprint) {
        throw new BrowserCompanionError("ChatGPT account changed before the action could start", "authentication_required");
      }
      ownedPage = page;
      if (execution.request.prompt.kind === "pair_verify") await this.replacePairingDraft(execution.request);
      await clearExistingDraft(page,execution.signal);
      if (execution.request.prompt.kind !== "pair_verify" && !creating) {
        // Offline actions are dispatched after tool-call inactivity. Stop only
        // while preparing this send; ongoing conversations need no observation.
        await stopLingeringResponse(page, execution.signal, { canonicalUrl, accountFingerprint:account.fingerprint });
        if (canonicalChatGptConversationUrl(page.url()) !== canonicalUrl) {
          throw new BrowserCompanionError("ChatGPT changed conversations while stopping the previous response", "conversation_unavailable");
        }
      }
      const cache = this.capabilitiesCache;
      await clearExistingDraft(page,execution.signal);
      execution.emit({ type:"composer_ready" });
      let selected: Awaited<ReturnType<typeof selectModelAndEffort>> | null = null;
      if (!creating && execution.request.prompt.kind !== "pair_verify"
        && execution.request.model !== null && execution.request.effort !== null) {
        selected = await selectModelAndEffort(
        page,
        execution.request.model,
        execution.request.effort,
        cache?.accountFingerprint === account.fingerprint ? cache.capabilities : undefined,
        execution.signal,
      );
      execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
      }
      if (creating || execution.request.prompt.kind === "pair_verify") {
        pairingSelection = await selectPairingMedium(page, execution.signal);
      }
      selectedConnector = await selectConnector(page, execution.request.connectorName, execution.signal);
      this.connectorApps.remember(account.fingerprint,execution.request.connectorName,selectedConnector.identity);
      execution.emit({ type:"connector_verified" });
      // Read history before inserting a prompt: unsupported markers must not
      // make a newly filled composer flash and disappear during failure cleanup.
      const baseline = await captureSubmissionBaseline(page, execution.renderedPrompt);
      insertionAttempted = true;
      try {await insertExactPrompt(selectedConnector.composer, execution.renderedPrompt);}
      catch(error){
        if(error instanceof BrowserCompanionError)throw error;
        throw new BrowserCompanionError("ChatGPT did not accept the message in its editor; nothing was sent","external_interference",{cause:error});
      }
      const send = await uniqueSendButton(await activeComposer(page, 30_000, execution.signal), 30_000, execution.signal);
      if (pairingSelection) await pairingSelection.verify(execution.signal);
      else if (selected) await assertSelectedModelAndEffort(page, selected, execution.signal, creating);
      if (!await connectorIsSelected(await activeComposer(page, 30_000, execution.signal), execution.request.connectorName, selectedConnector.identity)) {
        throw new BrowserCompanionError("ChatGPT changed the selected connector before Send", "external_interference");
      }
      if (await composerText(await activeComposer(page, 30_000, execution.signal)) !== execution.renderedPrompt) {
        throw new BrowserCompanionError("ChatGPT composer text changed before Send", "external_interference");
      }
      if (creating) await assertNewChatDraft(page, execution.request.url === "https://chatgpt.com/new" ? null : execution.request.url);
      else if (canonicalChatGptConversationUrl(page.url()) !== canonicalUrl) {
        throw new BrowserCompanionError("ChatGPT changed the verified conversation before Send", "conversation_unavailable");
      }
      execution.signal.throwIfAborted();
      sendActivated = true;
      if(this.pendingSubmission?.actionId===execution.request.actionId)this.pendingSubmission.mayHaveSent=true;
      await send.click({ timeout:10_000, signal:execution.signal });
      try {
        await waitForSubmissionAcceptance(page, baseline, Date.now() + 30_000, execution.signal);
      } catch (error) {
        throw new BrowserCompanionError(
          "ChatGPT Send may have been accepted, but semantic acceptance could not be proven",
          "ambiguous_send",
          { sendAccepted:true, cause:error },
        );
      }
      sendAccepted = true;
      execution.emit({ type:"send_accepted" });
      if (creating) {
        const created = new URL(await createdChatUrl(page, execution.signal)); created.search = ""; created.hash = ""; canonicalUrl = created.href;
        // Persist the actual chat identity before model restoration can fail or time out.
        execution.emit({type:"conversation_created",canonicalUrl});
      }
      restoreUrl = canonicalUrl;
      if (pairingSelection) {
        await this.restorePairingSelection(page, pairingSelection, restoreUrl, execution.request.expectedAccountFingerprint);
        pairingSelection = undefined;
      }
      if (creating && execution.request.model !== null && execution.request.effort !== null) {
        // The initialization message only borrows Medium. Apply the user's
        // conversation preferences after acceptance, never to the pairing send.
        if (canonicalChatGptConversationUrl(page.url()) !== canonicalChatGptConversationUrl(canonicalUrl)
          || (await readChatGptAccount(page)).fingerprint !== execution.request.expectedAccountFingerprint) {
          throw new BrowserCompanionError("ChatGPT changed the new conversation before applying its settings", "external_interference");
        }
        selected = await selectModelAndEffort(page, execution.request.model, execution.request.effort,
          cache?.accountFingerprint === account.fingerprint ? cache.capabilities : undefined, execution.signal);
        await assertSelectedModelAndEffort(page, selected, execution.signal);
        execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
      }
      execution.emit({ type:"submission_complete", canonicalUrl });
    } catch (error) {
      if (!sendActivated && insertionAttempted && ownedPage) {
        // A failed readiness check must not leave our own unchanged prompt blocking retries.
        // Never clear a draft that was edited, moved, or might already have been submitted.
        try {
          if ((execution.request.prompt.kind === "create_chat" ? ownedPage.url() === restoreUrl : canonicalChatGptConversationUrl(ownedPage.url()) === canonicalChatGptConversationUrl(execution.request.expectedUrl))
            && !await generationRunning(ownedPage)) {
            const composer = await activeComposer(ownedPage, 2_000);
            if (await composerText(composer) === execution.renderedPrompt
              && await connectorIsSelected(composer, execution.request.connectorName, selectedConnector?.identity)) {
              await clearComposerState(ownedPage, execution.request.connectorName);
            }
          }
        } catch { /* Preserve the original failure when safe cleanup is unavailable. */ }
      }
      if (sendActivated && !sendAccepted && !(error instanceof BrowserCompanionError && error.code === "ambiguous_send")) {
        throw new BrowserCompanionError(
          asCompanionError(error).message,
          "ambiguous_send",
          { sendAccepted:true, cause:error },
        );
      }
      if (sendAccepted && error instanceof BrowserCompanionError && !error.sendAccepted) {
        throw new BrowserCompanionError(error.message, error.code, { sendAccepted:true, cause:error });
      }
      throw error;
    } finally {
      try {
        if (pairingSelection && ownedPage && restoreUrl) {
          try { await this.restorePairingSelection(ownedPage, pairingSelection, restoreUrl, execution.request.expectedAccountFingerprint); }
          catch (error) {
            throw new BrowserCompanionError("Could not restore the conversation's model and effort after the one-off pairing request", "model_unavailable", {sendAccepted:sendActivated, cause:error});
          }
        }
      } finally {
        if(this.pendingSubmission?.actionId===execution.request.actionId)this.pendingSubmission=undefined;
        await this.surface.endAction();
      }
    }
  }

  submissionMayHaveBeenAccepted(actionId:string):boolean {
    return this.pendingSubmission?.actionId===actionId && this.pendingSubmission.mayHaveSent;
  }

  private async restorePairingSelection(page: Page, selection: PairingMediumSelection, url: string, account: string): Promise<void> {
    let sameTarget = page.url() === url;
    if (!sameTarget) {
      try { sameTarget = canonicalChatGptConversationUrl(page.url()) === canonicalChatGptConversationUrl(url); }
      catch { /* A fresh top-level chat has no conversation ID until Send. */ }
    }
    if (!sameTarget
      || (await readChatGptAccount(page)).fingerprint !== account) {
      throw new BrowserCompanionError("ChatGPT changed the pairing target before restoring its settings", "external_interference");
    }
    await selection.restore(AbortSignal.timeout(10_000));
  }

  async close(): Promise<void> {
    this.healthAccount.dispose();
    await this.surface.close();
  }

}
