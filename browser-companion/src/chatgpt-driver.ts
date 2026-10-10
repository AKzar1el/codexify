import type { Locator, Page } from "playwright-core";
import { readChatGptAccount } from "./account";
import { resolveToolApproval, throwIfSessionAttention, toolApprovalVisible } from "./browser-session";
import type { BrowserDriver, DriverExecution } from "./browser-window";
import { activeComposer, composerText, insertExactPrompt, uniqueSendButton } from "./composer";
import { connectorIsSelected, selectConnector } from "./connector-selection";
import { BrowserCompanionError } from "./errors";
import { assertSelectedModelAndEffort, selectModelAndEffort } from "./model-selection";
import { buildCapabilityCatalog, type AccountCapabilities } from "./models";
import { canonicalChatGptConversationUrl, validateChatGptConversationUrl, type CapabilityCatalog } from "./protocol";
import { responseDomSnapshot, ChatGptVisibleTraceTracker, type ChatGptResponseDomCache } from "./response-observer";
import { ChatGptMarkdownBuffer } from "./response-stream";
import {
  CHATGPT_STOP_BUTTON_SELECTOR,
  assertAuthenticatedChatGptPage,
  detectChatGptAccountCapabilities,
} from "./session";
import {
  captureSubmissionBaseline,
  readTurnDomState,
  reconcileAssistantTurn,
  waitForAssistantTurn,
  waitForSubmissionAcceptance,
  type AssistantTurnBinding,
  type SubmissionBaseline,
} from "./turn-binding";

export interface SingleBrowserSurface {
  page(): Promise<Page>;
  navigate(url: string, signal?: AbortSignal): Promise<Page>;
  reveal(): Promise<void>;
  beginAction(): Promise<void>;
  endAction(): Promise<void>;
  close(): Promise<void>;
}

const ACTION_TIMEOUT_MS = 30 * 60_000;
const RESPONSE_SETTLE_MS = 2_000;
const POLL_MS = 100;

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
  if (await generationRunning(page)) {
    throw new BrowserCompanionError("The shared ChatGPT conversation is already generating", "external_interference");
  }
  return { page, canonicalUrl };
}

export class ChatGptBrowserDriver implements BrowserDriver {
  private capabilitiesCache?: {
    accountFingerprint:string;
    capabilities:AccountCapabilities;
    catalog:CapabilityCatalog;
  };

  constructor(private readonly surface: SingleBrowserSurface, private readonly build: string) {}

  async health(): Promise<{
    authenticated:boolean;
    accountFingerprint:string | null;
    status:"idle" | "busy" | "authentication_required" | "unavailable";
    detail:string | null;
  }> {
    try {
      const page = await this.surface.page();
      await assertAuthenticatedChatGptPage(page);
      const account = await readChatGptAccount(page);
      try {
        await throwIfSessionAttention(page);
      } catch (error) {
        if (error instanceof BrowserCompanionError && error.code === "authentication_required") {
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
          detail:error instanceof Error ? error.message : "ChatGPT requires attention",
        };
      }
      if (await generationRunning(page)) {
        return {
          authenticated:true,
          accountFingerprint:account.fingerprint,
          status:"busy",
          detail:"The shared ChatGPT window is already generating a response",
        };
      }
      if (await toolApprovalVisible(page)) {
        return {
          authenticated:true,
          accountFingerprint:account.fingerprint,
          status:"busy",
          detail:"The shared ChatGPT window is waiting for tool approval",
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
      if ((await composerText(composer)).trim()) {
        return {
          authenticated:true,
          accountFingerprint:account.fingerprint,
          status:"busy",
          detail:"The shared ChatGPT window contains a user draft",
        };
      }
      return {
        authenticated:true,
        accountFingerprint:account.fingerprint,
        status:"idle",
        detail:null,
      };
    } catch (error) {
      return {
        authenticated:false,
        accountFingerprint:null,
        status:"authentication_required",
        detail:error instanceof Error ? error.message : "ChatGPT sign-in is required",
      };
    }
  }

  async login(): Promise<{
    authenticated:boolean;
    accountFingerprint:string | null;
    status:"idle" | "busy" | "authentication_required" | "unavailable";
    detail:string | null;
  }> {
    await this.surface.navigate("https://chatgpt.com/");
    await this.surface.reveal();
    return this.health();
  }

  async capabilities(): Promise<CapabilityCatalog> {
    let page = await this.surface.page();
    if (new URL(page.url()).origin !== "https://chatgpt.com") {
      page = await this.surface.navigate("https://chatgpt.com/");
    }
    await throwIfSessionAttention(page);
    try {
      await assertAuthenticatedChatGptPage(page);
    } catch (error) {
      throw new BrowserCompanionError("Sign in to ChatGPT before refreshing browser capabilities", "authentication_required", { cause:error });
    }
    const account = await readChatGptAccount(page);
    const capabilities = await detectChatGptAccountCapabilities(page);
    const catalog = buildCapabilityCatalog(capabilities, account.fingerprint, this.build);
    this.capabilitiesCache = { accountFingerprint:account.fingerprint, capabilities, catalog };
    return catalog;
  }

  async reveal(url: string | null): Promise<void> {
    if (url) await this.surface.navigate(url);
    await this.surface.reveal();
  }

  async execute(execution: DriverExecution): Promise<void> {
    await this.surface.beginAction();
    let sendActivated = false;
    let sendAccepted = false;
    try {
      execution.emit({ type:"navigating" });
      const { page, canonicalUrl } = await exactConversationPage(
        this.surface,
        execution.request.url,
        execution.request.expectedUrl,
        execution.signal,
      );
      const account = await readChatGptAccount(page);
      let cache = this.capabilitiesCache;
      if (!cache || cache.accountFingerprint !== account.fingerprint) {
        const capabilities = await detectChatGptAccountCapabilities(page);
        cache = {
          accountFingerprint:account.fingerprint,
          capabilities,
          catalog:buildCapabilityCatalog(capabilities, account.fingerprint, this.build),
        };
        this.capabilitiesCache = cache;
      }
      const composer = await activeComposer(page, 30_000, execution.signal);
      if ((await composerText(composer)).trim()) {
        throw new BrowserCompanionError("ChatGPT composer contains a user draft", "external_interference");
      }
      execution.emit({ type:"composer_ready" });
      const selected = await selectModelAndEffort(
        page,
        execution.request.model,
        execution.request.effort,
        cache.capabilities,
        execution.signal,
      );
      execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
      const selectedComposer = await selectConnector(page, execution.request.connectorName, execution.signal);
      execution.emit({ type:"connector_verified" });
      await insertExactPrompt(selectedComposer, execution.renderedPrompt);
      const baseline = await captureSubmissionBaseline(page, execution.renderedPrompt);
      await assertSelectedModelAndEffort(page, selected, execution.signal);
      if (!await connectorIsSelected(await activeComposer(page, 30_000, execution.signal), execution.request.connectorName)) {
        throw new BrowserCompanionError("ChatGPT changed the selected connector before Send", "external_interference");
      }
      const send = await uniqueSendButton(await activeComposer(page, 30_000, execution.signal));
      sendActivated = true;
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
      let binding = await waitForAssistantTurn(page, baseline, Date.now() + 60_000, execution.signal);
      await this.observeResponse(
        page,
        baseline,
        binding,
        canonicalUrl,
        execution,
      );
    } catch (error) {
      if (sendActivated && !sendAccepted && !(error instanceof BrowserCompanionError && error.code === "ambiguous_send")) {
        throw new BrowserCompanionError(
          error instanceof Error ? error.message : String(error),
          "ambiguous_send",
          { sendAccepted:true, cause:error },
        );
      }
      if (sendAccepted && error instanceof BrowserCompanionError && !error.sendAccepted) {
        throw new BrowserCompanionError(error.message, error.code, { sendAccepted:true, cause:error });
      }
      throw error;
    } finally {
      await this.surface.endAction();
    }
  }

  async close(): Promise<void> {
    await this.surface.close();
  }

  private async observeResponse(
    page: Page,
    baseline: SubmissionBaseline,
    initialBinding: AssistantTurnBinding,
    canonicalUrl: string,
    execution: DriverExecution,
  ): Promise<void> {
    const markdown = new ChatGptMarkdownBuffer(undefined, 0);
    const trace = new ChatGptVisibleTraceTracker();
    const cache: ChatGptResponseDomCache = {};
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    let binding = initialBinding;
    let completionSignature: string | undefined;
    let completionSince = 0;
    while (Date.now() < deadline) {
      if (execution.signal.aborted) {
        throw new BrowserCompanionError("Browser observation was cancelled after Send", "ambiguous_send", { sendAccepted:true });
      }
      await throwIfSessionAttention(page);
      await resolveToolApproval(
        page,
        execution.request.connectorName,
        execution.request.autoApproveToolCalls,
        execution.signal,
      );
      if (canonicalChatGptConversationUrl(page.url()) !== canonicalUrl) {
        throw new BrowserCompanionError("ChatGPT navigated away from the paired conversation", "external_interference", { sendAccepted:true });
      }
      const state = await readTurnDomState(page);
      const acceptedUsers = new Set([...baseline.initialTurnIdentities, baseline.acceptedUserIdentity].filter(Boolean));
      if (state.userIdentities.some(identity => !acceptedUsers.has(identity))) {
        throw new BrowserCompanionError("Another user message appeared during the owned browser action", "external_interference", { sendAccepted:true });
      }
      binding = await reconcileAssistantTurn(page, baseline, binding);
      const snapshot = await responseDomSnapshot(binding.locator, cache);
      for (const event of trace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
        if (event.kind === "commentary") {
          execution.emit({ type:"commentary_delta", markdown:event.text, continuation:event.continuation === true });
        } else {
          execution.emit({ type:"status_delta", text:event.text, continuation:event.continuation === true });
        }
      }
      const answerDelta = markdown.observe(snapshot.markdownSegments);
      if (answerDelta) execution.emit({ type:"answer_delta", markdown:answerDelta, continuation:true });
      const running = await generationRunning(page);
      const current = snapshot.visibleText;
      if (responseCompletionReady({
        responsePresent:snapshot.responsePresent,
        generationRunning:running,
        answer:current,
        completionActionVisible:snapshot.completionActionVisible,
      })) {
        const signature = `${snapshot.fullHtml}\0${current}`;
        if (completionSignature !== signature) {
          completionSignature = signature;
          completionSince = Date.now();
        } else if (Date.now() - completionSince >= RESPONSE_SETTLE_MS) {
          const final = markdown.finish();
          if (final.delta) execution.emit({ type:"answer_delta", markdown:final.delta, continuation:true });
          execution.emit({ type:"generation_complete", finalMarkdown:final.markdown || null, canonicalUrl });
          return;
        }
      } else {
        completionSignature = undefined;
        completionSince = 0;
      }
      if (snapshot.stoppedThinkingVisible && !running) {
        throw new BrowserCompanionError("ChatGPT stopped thinking without a stable completed answer", "failed", { sendAccepted:true });
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    throw new BrowserCompanionError("ChatGPT response observation timed out", "ambiguous_send", { sendAccepted:true });
  }
}
