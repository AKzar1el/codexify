// Derived from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/browser-worker.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import type { Locator, Page } from "patchright";
import {selectorDrift} from "./errors";
import {throwIfConversationLimit} from "./browser-session";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptAssistantTurnSelector,
} from "./session";

export type TurnRole = "user" | "assistant";

export interface TurnDomState {
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
  generationRunning: boolean;
}

export interface SubmissionBaseline {
  initialTurnIdentities: readonly string[];
  submittedText: string;
  acceptedUserIdentity?: string;
}

export interface AssistantTurnBinding {
  identity: string;
  locator: Locator;
  acceptedTurnIdentities: readonly string[];
}

export function turnIdentityFromAttributes(input: {
  role: TurnRole;
  turnKey: string | null;
  turnId: string | null;
}): string {
  if (input.turnKey?.trim()) return `group:${input.role}:${input.turnKey}`;
  if (input.turnId?.trim()) return input.turnId;
  throw new Error("ChatGPT conversation turn has no stable identity");
}

export function newTurnIdentity(initial: readonly string[], current: readonly string[]): string | undefined {
  const previous = new Set(initial);
  const added = [...new Set(current)].filter(identity => !previous.has(identity));
  if (added.length > 1) {
    throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  }
  return added[0];
}

export function reboundTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return newTurnIdentity(initial, current);
}

export type SubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running";

export function submissionEvidence(state: {
  initialTurnIdentities: readonly string[];
  userIdentities: readonly string[];
  responseIdentities: readonly string[];
  generationRunning: boolean;
}): SubmissionEvidence | undefined {
  if (newTurnIdentity(state.initialTurnIdentities, state.userIdentities)) return "user_turn";
  if (newTurnIdentity(state.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

function unique(values: string[], kind: string): string[] {
  if (values.some(value => value.trim().length === 0)) {
    throw selectorDrift(`ChatGPT conversation ${kind} has an empty stable identity`);
  }
  // Responsive views and remount transitions may render more than one physical
  // node for the same logical turn. Stable IDs, rather than node counts, bind Send.
  return [...new Set(values)];
}

export async function readTurnDomState(page: Page): Promise<TurnDomState> {
  return page.evaluate(({ userSelector, assistantSelector, stopSelector }) => {
    const legacy = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(element => !element.closest("[data-turn-key]"));
    const legacyIdentity = (element: HTMLElement): string => {
      const id = element.getAttribute("data-turn-id");
      if (!id?.trim()) throw new Error("ChatGPT legacy turn has no stable data-turn-id");
      return id;
    };
    const userIdentities = legacy(userSelector).map(legacyIdentity);
    const responseIdentities = legacy(assistantSelector).map(legacyIdentity);
    const turnIdentities = [...document.querySelectorAll<HTMLElement>("[data-turn-id-container]")]
      .filter(element => !element.closest("[data-turn-key]")
        && element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
          !== element.getAttribute("data-turn-id-container"))
      .map(element => {
        const id = element.getAttribute("data-turn-id-container");
        if (!id?.trim()) throw new Error("ChatGPT turn container has no stable identity");
        return id;
      });
    for (const group of document.querySelectorAll<HTMLElement>("[data-turn-key]")) {
      const key = group.getAttribute("data-turn-key");
      if (!key?.trim()) throw new Error("ChatGPT grouped turn has no stable data-turn-key");
      const user = `group:user:${key}`;
      const assistant = `group:assistant:${key}`;
      turnIdentities.push(user, assistant);
      if (group.querySelector("[data-user-message-bubble]")) userIdentities.push(user);
      if (group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]')) {
        responseIdentities.push(assistant);
      }
    }
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element as HTMLElement);
      return (element as HTMLElement).isConnected
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const generationRunning = [...document.querySelectorAll(stopSelector)].some(visible);
    return { turnIdentities, userIdentities, responseIdentities, generationRunning };
  }, {
    userSelector:CHATGPT_USER_TURN_SELECTOR,
    assistantSelector:CHATGPT_ASSISTANT_TURN_SELECTOR,
    stopSelector:CHATGPT_STOP_BUTTON_SELECTOR,
  }).catch(error=>{
    const reasons=["ChatGPT legacy turn has no stable data-turn-id","ChatGPT turn container has no stable identity","ChatGPT grouped turn has no stable data-turn-key"];
    const detail=error instanceof Error?reasons.find(reason=>error.message.includes(reason)):undefined;
    throw selectorDrift(detail??"ChatGPT conversation history could not be inspected before sending",error);
  }).then(state => ({
    turnIdentities:unique(state.turnIdentities, "turn"),
    userIdentities:unique(state.userIdentities, "user turn"),
    responseIdentities:unique(state.responseIdentities, "assistant turn"),
    generationRunning:state.generationRunning,
  }));
}

export async function captureSubmissionBaseline(page: Page, submittedText: string): Promise<SubmissionBaseline> {
  if (!submittedText) throw new Error("Submitted prompt must not be empty");
  return { initialTurnIdentities:(await readTurnDomState(page)).turnIdentities, submittedText };
}

export async function waitForSubmissionAcceptance(
  page: Page,
  baseline: SubmissionBaseline,
  deadline: number,
  signal?: AbortSignal,
): Promise<SubmissionEvidence> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    await throwIfConversationLimit(page);
    const state = await readTurnDomState(page);
    const evidence = submissionEvidence({ ...state, initialTurnIdentities:baseline.initialTurnIdentities });
    if (evidence === "user_turn") {
      const identity = newTurnIdentity(baseline.initialTurnIdentities, state.userIdentities)!;
      if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
        throw new Error("ChatGPT changed the user turn that acknowledged Send");
      }
      baseline.acceptedUserIdentity = identity;
    }
    if (evidence) return evidence;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("ChatGPT Send did not produce semantic acceptance evidence");
}

export async function waitForAssistantTurn(
  page: Page,
  baseline: SubmissionBaseline,
  deadline: number,
  signal?: AbortSignal,
): Promise<AssistantTurnBinding> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    const state = await readTurnDomState(page);
    const identity = newTurnIdentity(baseline.initialTurnIdentities, state.responseIdentities);
    if (identity) {
      return {
        identity,
        locator:page.locator(chatGptAssistantTurnSelector(identity)),
        acceptedTurnIdentities:state.turnIdentities,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("ChatGPT accepted the message but exposed no assistant turn");
}

export async function reconcileAssistantTurn(
  page: Page,
  baseline: SubmissionBaseline,
  binding: AssistantTurnBinding,
): Promise<AssistantTurnBinding> {
  const count = await binding.locator.count();
  if (count === 1) return binding;
  if (count > 1) throw new Error("ChatGPT exposed duplicate nodes for the bound assistant turn");
  const state = await readTurnDomState(page);
  const accepted = new Set([...binding.acceptedTurnIdentities, ...baseline.initialTurnIdentities]);
  const newUsers = state.userIdentities.filter(identity => !accepted.has(identity));
  if (newUsers.length > 0) {
    throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
  }
  const identity = reboundTurnIdentity(baseline.initialTurnIdentities, binding.identity, state.responseIdentities);
  if (!identity || identity === binding.identity) return binding;
  return {
    identity,
    locator:page.locator(chatGptAssistantTurnSelector(identity)),
    acceptedTurnIdentities:state.turnIdentities,
  };
}
