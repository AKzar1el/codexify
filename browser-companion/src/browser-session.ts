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
  if (await page.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false)
    || await terminalErrorAlert(page).isVisible().catch(() => false)) {
    throw new BrowserCompanionError("ChatGPT displayed a terminal response error.", "failed");
  }
}
