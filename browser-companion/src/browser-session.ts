// Adapted from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/browser-worker.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import type { Locator, Page } from "playwright-core";
import { BrowserCompanionError } from "./errors";

const rateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText:/Too many requests|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i })
  .filter({ hasText:/making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i })
  .last();

const expiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText:/Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i })
  .last();

const subscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText:/Failed to load subscription/i })
  .last();

const terminalErrorAlert = (page: Page): Locator => page
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

const anyToolApproval = (page: Page): Locator => page
  .locator('[role="dialog"], [data-testid="tool-approval-card"], [data-codex-approval-surface="true"]')
  .filter({ hasText:/Allow ChatGPT to use .+\?/i })
  .filter({ visible:true });

export async function toolApprovalVisible(page: Page): Promise<boolean> {
  return anyToolApproval(page).count().then(count => count > 0).catch(() => false);
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

export async function resolveToolApproval(
  page: Page,
  connectorName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
): Promise<"none" | "approved"> {
  const dialogs = page.locator('[role="dialog"], [data-testid="tool-approval-card"], [data-codex-approval-surface="true"]')
    .filter({ has:page.getByText(`Allow ChatGPT to use ${connectorName}?`, { exact:true }) })
    .filter({ visible:true });
  const count = await dialogs.count();
  if (count === 0) return "none";
  if (count !== 1) throw new BrowserCompanionError("ChatGPT exposed multiple connector approvals", "approval_required", { sendAccepted:true });
  const dialog = dialogs.first();
  if (!autoApprove) {
    throw new BrowserCompanionError("ChatGPT requires one-time approval in the shared browser window", "approval_required", { sendAccepted:true });
  }
  const allow = dialog.getByRole("button", { name:/^Allow(?: once)?$/ }).filter({ visible:true });
  const deny = dialog.getByRole("button", { name:"Deny", exact:true }).filter({ visible:true });
  await allow.waitFor({ state:"visible", timeout:10_000, signal });
  await deny.waitFor({ state:"visible", timeout:10_000, signal });
  if (await allow.count() !== 1 || await deny.count() !== 1) {
    throw new BrowserCompanionError("ChatGPT approval does not expose one unique temporary Allow action", "approval_required", { sendAccepted:true });
  }
  await allow.click({ timeout:10_000, signal });
  await dialog.waitFor({ state:"hidden", timeout:10_000, signal });
  return "approved";
}
