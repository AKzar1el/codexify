// Derived from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/browser-worker.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
// Exact insertion semantics remain structurally aligned with upstream.
import type { Locator, Page } from "patchright";
import { CHATGPT_COMPOSER_SELECTOR, CHATGPT_SEND_BUTTON_SELECTOR } from "./session";
import { renderActionPrompt } from "./protocol";
import { BrowserCompanionError } from "./errors";

export const COMPOSER_READY_TIMEOUT_MS = 30_000;

export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

export function verifyOwnedComposerText(actual: string, expected: string): boolean {
  return expected.length > 0 && actual === expected;
}

export function isPairingVerificationDraft(text: string): boolean {
  const reference = text.match(/\ncalling `automation_verify_pairing` with the non-secret: ([A-Za-z0-9_-]+)\n/)?.[1];
  if (!reference) return false;
  try {
    return text === renderActionPrompt({ kind:"pair_verify", reference });
  } catch {
    return false;
  }
}

export async function activeComposer(
  page: Page,
  timeoutMs = COMPOSER_READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Locator> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible:true });
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    count = await composers.count();
    if (count === 1) {
      const composer = composers.first();
      if (await composer.isEditable().catch(() => false)) return composer;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`ChatGPT composer is unavailable or ambiguous (visible count=${count})`);
}

export async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate(element => {
    const root = element as HTMLElement;
    const clone = root.cloneNode(true) as HTMLElement;
    for (const pill of clone.querySelectorAll('[contenteditable="false"], [app-mention-path], [data-id^="plugin:"]')) {
      pill.remove();
    }
    // innerText on a detached clone falls back to textContent and joins separate
    // editor paragraphs without newlines. Project the editor's logical text instead.
    const text = (node: Node): string => {
      if (node.nodeType === 3) return node.textContent ?? "";
      if (node.nodeType === 1 && (node as Element).tagName === "BR") {
        const parent = node.parentElement;
        const emptyParagraph = parent && /^(P|DIV)$/.test(parent.tagName) && parent.childNodes.length === 1;
        return (node as Element).classList.contains("ProseMirror-trailingBreak") || emptyParagraph ? "" : "\n";
      }
      let result = "";
      let previousBlock = false;
      let hasPrevious = false;
      for (const child of node.childNodes) {
        const block = child.nodeType === 1 && /^(P|DIV)$/.test((child as Element).tagName);
        if (hasPrevious && (previousBlock || block)) result += "\n";
        result += text(child);
        previousBlock = block;
        hasPrevious = true;
      }
      return result;
    };
    return text(clone).replace(/^\s+/, "");
  });
}

export async function ensureEmptyOwnedComposer(composer: Locator): Promise<void> {
  const text = await composerText(composer);
  if (text.trim().length !== 0) {
    throw new Error("ChatGPT composer contains an existing draft; automation will not overwrite it");
  }
}

export async function insertExactPrompt(composer: Locator, prompt: string): Promise<void> {
  await ensureEmptyOwnedComposer(composer);
  const inserted = await composer.evaluate(insertPlainTextIntoComposer, prompt);
  if (!inserted) throw new Error("ChatGPT rejected exact plaintext composer insertion");
  const actual = await composerText(composer);
  if (!verifyOwnedComposerText(actual, prompt)) {
    throw new BrowserCompanionError("ChatGPT composer text changed during insertion; the message was not sent", "external_interference");
  }
}

export async function uniqueSendButton(
  composer: Locator,
  timeoutMs = COMPOSER_READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Locator> {
  const form = composer.locator("xpath=ancestor::form[1]");
  if (await form.count() !== 1) throw new BrowserCompanionError("ChatGPT composer does not have one owned form", "selector_drift");
  const send = form.locator(CHATGPT_SEND_BUTTON_SELECTOR).filter({ visible:true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    const count = await send.count();
    if (count > 1) throw new BrowserCompanionError("ChatGPT composer does not have one visible Send control", "selector_drift");
    if (count === 1 && await send.first().isEnabled().catch(() => false)) return send.first();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new BrowserCompanionError("ChatGPT Send control did not become ready; the message was not sent", "selector_drift");
}
