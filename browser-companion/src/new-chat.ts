import type { Page } from "patchright";
import {uiLabelPattern} from "./ui-localization";
import { activeComposer } from "./composer";
import { BrowserCompanionError } from "./errors";
import { assertAuthenticatedChatGptPage } from "./session";
import type { SingleBrowserSurface } from "./chatgpt-driver";

export function validateNewChatProjectUrl(value: string | null): string | null {
  if (value === null) return null;
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash
    || !/^\/g\/g-p-[^/]+\/project\/?$/.test(url.pathname)) throw new Error("Invalid ChatGPT project URL");
  return url.href;
}

export async function openNewChat(surface: SingleBrowserSurface, projectUrl: string | null, signal?: AbortSignal): Promise<Page> {
  const destination = validateNewChatProjectUrl(projectUrl) || "https://chatgpt.com/";
  const page = await surface.navigate(destination, signal);
  const composer = await activeComposer(page, 30_000, signal);
  await assertAuthenticatedChatGptPage(page);
  if (projectUrl) {
    const project = new URL(projectUrl).pathname.split('/')[2]!.replace(/^(g-p-[0-9a-f]{32}).*$/, '$1');
    const current = new URL(page.url());
    if (current.origin !== "https://chatgpt.com" || current.pathname.split('/')[2]?.replace(/^(g-p-[0-9a-f]{32}).*$/, '$1') !== project || !current.pathname.replace(/\/$/, '').endsWith('/project')) {
      throw new BrowserCompanionError("ChatGPT did not open the configured project", "conversation_unavailable");
    }
    // The project landing page's fresh composer is its New chat entry point.
    await composer.click({timeout:5_000, signal});
  } else {
    const entry = page.locator('[data-testid="create-new-chat-button"], [data-testid="new-chat-button"]');
    if (await entry.count() === 1) await entry.click({timeout:5_000, signal});
    else {
      const name=uiLabelPattern("newChat");
      const named = page.getByRole('link',{name}).or(page.getByRole('button',{name}));
      if (await named.count() === 1) await named.click({timeout:5_000, signal});
    }
    if (new URL(page.url()).origin !== "https://chatgpt.com" || new URL(page.url()).pathname !== '/') throw new BrowserCompanionError("ChatGPT did not open a new chat", "conversation_unavailable");
  }
  // The driver clears any draft after verifying the account. Existing messages
  // still mean this is not a fresh conversation.
  if (await page.locator('[data-message-author-role="user"], [data-message-author-role="assistant"]').count()) {
    throw new BrowserCompanionError("The new ChatGPT chat is not empty", "external_interference");
  }
  return page;
}

export async function createdChatUrl(page: Page, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + 30_000;
  do {
    if (signal.aborted) throw new DOMException("Browser action aborted", "AbortError");
    const url = new URL(page.url());
    const match = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/.exec(url.pathname);
    if (url.origin === 'https://chatgpt.com' && match && !decodeURIComponent(match[1]!).startsWith('local-chatgpt:')) return url.href;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new BrowserCompanionError("ChatGPT accepted the new chat but its conversation URL could not be confirmed", "ambiguous_send", {sendAccepted:true});
}

export async function assertNewChatDraft(page: Page, projectUrl: string | null): Promise<void> {
  const current = new URL(page.url());
  const projectKey = (url:URL) => url.pathname.split('/')[2]?.replace(/^(g-p-[0-9a-f]{32}).*$/, '$1');
  const valid = current.origin === 'https://chatgpt.com' && (projectUrl
    ? projectKey(current) === projectKey(new URL(projectUrl))
    : current.pathname === '/' || /^\/c\/[^/]+\/?$/.test(current.pathname));
  if (!valid || await page.locator('[data-message-author-role="user"], [data-user-message-bubble]').count()) {
    throw new BrowserCompanionError('ChatGPT left the new chat before Send', 'conversation_unavailable');
  }
}
