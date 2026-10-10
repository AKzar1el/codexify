// Derived from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/browser-worker.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import type { Locator, Page } from "playwright-core";
import { activeComposer, composerText } from "./composer";
import { BrowserCompanionError } from "./errors";

const CONNECTOR_MENTION_QUERY = "@codex";
const CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const MAX_CONNECTOR_TRIGGER_ATTEMPTS = 3;

export function connectorSelectionSelector(name: string): string {
  if (!name.trim() || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("Connector name is invalid");
  }
  const encoded = JSON.stringify(name);
  return [
    `[data-id^="plugin:"][data-keyword=${encoded}]`,
    `[app-mention-path^="app://"][app-mention-display-name=${encoded}][contenteditable="false"]`,
  ].join(", ");
}

export function selectedConnectorControl(composer: Locator, name: string): Locator {
  return composer.locator(connectorSelectionSelector(name)).filter({ visible:true });
}

export async function connectorIsSelected(composer: Locator, name: string): Promise<boolean> {
  const selected = selectedConnectorControl(composer, name);
  const names = await selected.evaluateAll(elements => elements.map(element => (
    element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name")
  )));
  const exact = names.filter(value => value === name).length;
  if (exact > 1) throw new BrowserCompanionError(`ChatGPT exposed duplicate ${JSON.stringify(name)} connector selections`, "connector_unavailable");
  return exact === 1;
}

export function normalizeConnectorRowTitles(texts: readonly string[]): string[] {
  return texts
    .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export async function clearComposerState(page: Page, connectorName: string, signal?: AbortSignal): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  const composer = await activeComposer(page, 30_000, signal);
  await composer.focus({ timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
  await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
  await composer.press("Backspace", { timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const settled = await activeComposer(page, 5_000, signal);
    const text = await composerText(settled);
    const selected = await connectorIsSelected(settled, connectorName);
    if (!text.trim() && !selected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new BrowserCompanionError("ChatGPT connector cleanup did not produce an empty composer", "external_interference");
}

async function mentionRowTitles(rows: Locator): Promise<string[]> {
  try {
    return normalizeConnectorRowTitles(await rows.filter({ visible:true }).allInnerTexts());
  } catch {
    return [];
  }
}

export async function selectConnector(
  page: Page,
  connectorName: string,
  signal?: AbortSignal,
): Promise<Locator> {
  let composer = await activeComposer(page, 30_000, signal);
  if (await connectorIsSelected(composer, connectorName)) {
    if (!(await composerText(composer)).trim()) return composer;
    await clearComposerState(page, connectorName, signal);
    composer = await activeComposer(page, 30_000, signal);
  }
  if ((await composerText(composer)).trim()) {
    throw new BrowserCompanionError("ChatGPT composer contains an existing draft; connector selection will not overwrite it", "external_interference");
  }
  const rows = page.locator('.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]');
  const exactRow = rows.filter({ has:page.getByText(connectorName, { exact:true }) });
  let attempts = 0;
  try {
    while (attempts < MAX_CONNECTOR_TRIGGER_ATTEMPTS) {
      attempts += 1;
      composer = await activeComposer(page, 30_000, signal);
      await composer.fill("", { timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
      await composer.focus({ timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
      await composer.pressSequentially(CONNECTOR_MENTION_QUERY, {
        delay:25,
        timeout:CONNECTOR_ACTION_TIMEOUT_MS,
        signal,
      });
      try {
        await exactRow.waitFor({ state:"visible", timeout:2_500, signal });
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        const titles = await mentionRowTitles(rows);
        if (attempts >= MAX_CONNECTOR_TRIGGER_ATTEMPTS) {
          const detail = titles.length
            ? `ChatGPT connector menu exposed ${titles.map(title => JSON.stringify(title)).join(", ")}`
            : "ChatGPT connector menu did not open";
          throw new BrowserCompanionError(
            `${detail}, but no exact row named ${JSON.stringify(connectorName)} was available`,
            "connector_unavailable",
            { cause:error },
          );
        }
      }
    }
    if (await exactRow.count() !== 1) {
      throw new BrowserCompanionError(`ChatGPT did not expose one exact ${JSON.stringify(connectorName)} connector row`, "connector_unavailable");
    }
    const highlighted = async () => (
      await exactRow.getAttribute("data-highlighted") !== null
      || await exactRow.getAttribute("aria-current") === "true"
    );
    if (!await highlighted()) {
      const count = await rows.filter({ visible:true }).count();
      for (let index = 0; index < count && !await highlighted(); index += 1) {
        await composer.press("ArrowDown", { timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
      }
    }
    if (!await highlighted()) {
      throw new BrowserCompanionError(`ChatGPT connector menu could not highlight ${JSON.stringify(connectorName)}`, "connector_unavailable");
    }
    await composer.press("Enter", { timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
    const selected = await activeComposer(page, 30_000, signal);
    await selectedConnectorControl(selected, connectorName).waitFor({ state:"visible", timeout:CONNECTOR_ACTION_TIMEOUT_MS, signal });
    if (!await connectorIsSelected(selected, connectorName)) {
      throw new BrowserCompanionError(`ChatGPT did not retain the ${JSON.stringify(connectorName)} connector selection`, "connector_unavailable");
    }
    if ((await composerText(selected)).trim()) {
      throw new BrowserCompanionError("ChatGPT connector selection left an unexpected draft", "external_interference");
    }
    return selected;
  } catch (error) {
    try {
      await clearComposerState(page, connectorName, signal);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "ChatGPT connector selection failed and its draft could not be cleared");
    }
    throw error;
  }
}

export async function verifyConnector(page: Page, connectorName: string, signal?: AbortSignal): Promise<void> {
  await selectConnector(page, connectorName, signal);
  await clearComposerState(page, connectorName, signal);
}
