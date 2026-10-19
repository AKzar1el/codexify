// Adapted from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/browser-worker.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import type { Locator, Page } from "patchright";
import { BrowserCompanionError } from "./errors";
import {uiLabelPattern,uiTemplatePattern} from "./ui-localization";

const rateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText:uiLabelPattern("rateTitle",false) })
  .filter({ hasText:uiLabelPattern("rateBody",false) })
  .last();

const expiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText:uiLabelPattern("expiredTitle",false) })
  .last();

const subscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText:uiTemplatePattern("subscriptionFailure") })
  .last();

// Error semantics and the support destination are stable across UI languages.
// Scope the fallback to alerts/error surfaces so ordinary answer links do not match.
const terminalErrorAlert = (page: Page): Locator => page
  .locator('[role="alert"], [data-testid="conversation-turn-error"], [data-testid="conversation-error"], [data-error-code]')
  .filter({hasText:uiLabelPattern("terminalFailure",false)})
  .filter({hasText:/help\.openai\.com/i}).filter({visible:true}).last();

export async function conversationUnavailableVisible(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  if (url.origin !== "https://chatgpt.com" || !/^\/(?:g\/[^/]+\/)?c\/[^/]+\/?$/.test(url.pathname)) return false;
  return page.evaluate(() => {
    const main = document.querySelector('[data-app-shell-focus-area="main"]');
    // This is the full-page load failure, not text or controls inside a turn,
    // an empty new chat, or a signed-out page. The error has no stable test ID.
    if (!main || main.querySelector('form, [role="textbox"], textarea, [contenteditable="true"], article, [data-turn-key], [data-turn-id], [data-message-author-role]')) return false;
    const visible = (element: Element): boolean => {
      if (!element.getClientRects().length || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    };
    const panels = main.querySelectorAll(':scope > div > .flex.flex-col.items-center.justify-center > .flex.flex-col.items-center.justify-center.text-center.max-w-xl');
    return [...panels].some(panel => {
      if (panel.children.length !== 2 || !visible(panel)) return false;
      const [message, actions] = [...panel.children];
      const heading = message!.querySelector(':scope > .font-medium.text-default.text-lg');
      const buttons = actions!.querySelectorAll('button');
      return message!.matches('.flex.flex-col.items-center')
        && actions!.matches('.flex.flex-wrap.items-center.justify-center')
        && !!heading?.textContent?.trim() && visible(heading)
        && buttons.length === 1 && buttons[0]!.matches('button[type="button"]') && visible(buttons[0]!)
        && !panel.querySelector('a, input, select, [role="button"]');
    });
  });
}

export async function toolApprovalVisible(page: Page): Promise<boolean> {
  // This guard protects pairing-draft replacement. Any visible modal blocks it;
  // recognizing an English approval question is neither necessary nor sufficient.
  return page.locator('[role="dialog"], [role="alertdialog"], [data-testid="tool-approval-card"], [data-codex-approval-surface="true"]')
    .filter({visible:true}).count().then(count=>count>0).catch(()=>false);
}

export async function throwIfSessionAttention(page: Page): Promise<void> {
  if (await expiredSessionAlert(page).isVisible().catch(() => false)) {
    throw new BrowserCompanionError("The ChatGPT session has expired. Sign in again in the browser companion.", "authentication_required");
  }
  if (await rateLimitDialog(page).isVisible().catch(() => false)) {
    throw new BrowserCompanionError("ChatGPT rate limit: too many requests. Retry only after the account cooldown clears.", "rate_limited");
  }
  if (await subscriptionFailureAlert(page).isVisible().catch(() => false)) {
    throw new BrowserCompanionError("ChatGPT could not load the current subscription.", "failed");
  }
  if (await conversationUnavailableVisible(page)) {
    throw new BrowserCompanionError("ChatGPT conversation temporarily not accessible", "conversation_unavailable");
  }
  if (await page.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false)
    || await terminalErrorAlert(page).isVisible().catch(() => false)) {
    throw new BrowserCompanionError("ChatGPT displayed a terminal response error.", "failed");
  }
}
