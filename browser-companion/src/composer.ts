// Derived from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/browser-worker.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
// Exact insertion semantics remain structurally aligned with upstream.
import type { Locator, Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR, CHATGPT_SEND_BUTTON_SELECTOR } from "./session";

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
    return (clone.innerText ?? clone.textContent ?? "").replace(/^\s+/, "");
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
    throw new Error("ChatGPT composer text changed during insertion; the message was not sent");
  }
}

export async function uniqueSendButton(composer: Locator): Promise<Locator> {
  const form = composer.locator("xpath=ancestor::form[1]");
  if (await form.count() !== 1) throw new Error("ChatGPT composer does not have one owned form");
  const send = form.locator(CHATGPT_SEND_BUTTON_SELECTOR).filter({ visible:true });
  if (await send.count() !== 1) throw new Error("ChatGPT composer does not have one visible Send control");
  const button = send.first();
  if (await button.isDisabled().catch(() => true)) throw new Error("ChatGPT Send control is disabled");
  return button;
}
