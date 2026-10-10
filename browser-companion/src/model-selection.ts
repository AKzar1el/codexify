// Derived from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/model-selection.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import { activateChatGptEffortMenu, parseChatGptEffortSliderState, parseChatGptModelAnnouncement, readChatGptModelAnnouncements } from "./session";
import type { Locator, Page } from "playwright-core";
import { activeComposer, composerText } from "./composer";
import { readChatGptEffortSnapshot, CHATGPT_EFFORT_CONTROL_SELECTOR } from "./session";
import { resolveBrowserModel, type AccountCapabilities, type BrowserEffort, type BrowserModelFamily, type ResolvedBrowserModel } from "./models";
import { BrowserCompanionError } from "./errors";

type EffortMenu = Awaited<ReturnType<typeof activateChatGptEffortMenu>>;

function familyError(family: BrowserModelFamily, cause?: unknown): BrowserCompanionError {
  return new BrowserCompanionError(
    `ChatGPT model ${family} could not be selected and verified. The pending message was not sent. Check the model in the browser; if ChatGPT uses an unsupported language, select English in Settings → General → Language and reload it.`,
    "model_unavailable",
    { cause },
  );
}

function familyOption(menu: EffortMenu, family: BrowserModelFamily) {
  return menu.menu.getByRole("menuitemradio", {
    name: family === "5.6" ? /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i
      // Simplified/Traditional Chinese and Japanese share 最新; Korean uses 최신.
      : /^(?:Latest|最新|최신|(?:GPT[-\s]?)?6(?:\s+Astra)?(?:\s+Pro)?)$/i,
    exact: true,
    includeHidden: true,
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: BrowserModelFamily,
  activate: () => Promise<EffortMenu>,
): Promise<EffortMenu> {
  try {
    const option = familyOption(menu, family);
    if (await option.count() > 1) throw familyError(family);
    if (await option.count() === 1 && await option.getAttribute("aria-checked") === "true") return menu;
    // The attached radio rows are inert while this composer-owned advanced view is collapsed.
    const powerView = menu.menu.locator('[data-model-picker-view]');
    if (await powerView.count() === 1) {
      const view = await powerView.getAttribute("data-model-picker-view");
      if (view === "simple") {
        const trigger = powerView.locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])')
          .filter({ visible: true });
        if (await trigger.count() !== 1) throw familyError(family);
        await trigger.click({ timeout: 5_000 });
      } else if (view !== "advanced") throw familyError(family);
    } else {
      const trigger = menu.menu.locator('[role="menuitem"][aria-expanded][aria-hidden="false"]');
      if (await powerView.count() !== 0 || await trigger.count() !== 1) throw familyError(family);
      if (await trigger.getAttribute("aria-expanded") === "false") await trigger.click({ timeout: 5_000 });
    }
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    const selected = await activate();
    const deadline = Date.now() + 1_000;
    do {
      const current = familyOption(selected, family);
      if (await current.count() > 1) throw familyError(family);
      if (await current.count() === 1 && await current.getAttribute("aria-checked") === "true") return selected;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw familyError(family);
  } catch (cause) {
    if (cause instanceof BrowserCompanionError) throw cause;
    throw familyError(family, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: BrowserModelFamily,
  effort: BrowserEffort,
): boolean {
  // GPT-6 uses Sol below Pro and Astra at Pro. An old Latest picker can still use
  // 5.6 at lower efforts; that is not proof of an explicitly requested GPT-6 turn.
  const expectedName = family === "6" && effort === "max" ? "astra" : "sol";
  const states = descriptions.flatMap(text => {
    const state = parseChatGptModelAnnouncement(text);
    return state ? [state] : [];
  });
  return states.length > 0 && states.every(state => state.version === family
    && (!state.name || state.name === expectedName)
    && (effort === "max" ? /^Pro$/i.test(state.mode) : !/^Pro$/i.test(state.mode)));
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: BrowserModelFamily,
  effort: BrowserEffort,
  effortIndex: number,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  do {
    const option = familyOption(menu, family);
    const checked = await option.count() === 1 && await option.getAttribute("aria-checked") === "true";
    const state = parseChatGptEffortSliderState(
      await menu.slider.getAttribute("aria-valuemin"), await menu.slider.getAttribute("aria-valuemax"),
      await menu.slider.getAttribute("aria-valuenow"),
    );
    const descriptions = await readChatGptModelAnnouncements(menu.slider);
    if (checked && state && state.value === state.min + effortIndex && chatGptModelFamilyMatches(descriptions, family, effort)) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw familyError(family);
}

export interface SelectedBrowserModel extends ResolvedBrowserModel {
  selection: { url:string; label:string } | null;
}

async function setLunaThinkMode(
  composer: Locator,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const form = composer.locator("xpath=ancestor::form[1]");
  const controls = form.getByRole("button", { name:"Think", exact:true }).filter({ visible:true });
  const count = await controls.count();
  if (count > 1) throw new BrowserCompanionError("ChatGPT exposed multiple Think controls", "model_unavailable");
  const action = { timeout:10_000, signal };
  const control = controls.first();
  let pressed = count === 1 ? await control.getAttribute("aria-pressed", action) : null;
  const target = enabled ? "true" : "false";
  if (count === 0 && !enabled) return;
  if (count === 1 && pressed !== "true" && pressed !== "false") {
    throw new BrowserCompanionError("ChatGPT Think control has no semantic state", "model_unavailable");
  }
  if ((await composerText(composer)).trim()) {
    throw new BrowserCompanionError("ChatGPT Think selection requires an empty composer", "external_interference");
  }
  if (pressed !== target) {
    if (count === 1) {
      await control.click(action);
    } else {
      await composer.focus(action);
      await composer.press("End", action);
      await composer.pressSequentially("/think", { ...action, delay:25 });
      const popup = form.page().locator('.popover[aria-busy="false"]').filter({ visible:true });
      const rows = popup.locator('.__menu-item[tabindex="0"]').filter({ visible:true });
      await rows.first().waitFor({ state:"visible", timeout:5_000, signal });
      if (await popup.count() !== 1 || await rows.count() !== 1) {
        throw new BrowserCompanionError("ChatGPT Think command is unavailable", "model_unavailable");
      }
      const row = rows.first();
      if (await row.getAttribute("data-highlighted", action) === null) await composer.press("ArrowDown", action);
      if (await row.getAttribute("data-highlighted", action) === null) {
        throw new BrowserCompanionError("ChatGPT Think command cannot be selected", "model_unavailable");
      }
      await composer.press("Enter", action);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
      const current = form.getByRole("button", { name:"Think", exact:true }).filter({ visible:true });
      const currentCount = await current.count();
      if (currentCount > 1) throw new BrowserCompanionError("ChatGPT exposed multiple Think controls", "model_unavailable");
      pressed = currentCount === 1 ? await current.first().getAttribute("aria-pressed", action) : null;
      if (pressed === target) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (pressed !== target) throw new BrowserCompanionError("ChatGPT did not retain the requested Think mode", "model_unavailable");
  }
  if ((await composerText(composer)).trim()) {
    throw new BrowserCompanionError("ChatGPT Think selection mutated the prompt draft", "external_interference");
  }
}

async function availableEffort(menu: EffortMenu, index: number): Promise<Awaited<ReturnType<typeof readChatGptEffortSnapshot>>> {
  const state = await readChatGptEffortSnapshot(menu.sliderContainer).catch(error => {
    throw new BrowserCompanionError(
      "ChatGPT effort availability could not be verified",
      "model_unavailable",
      { cause:error },
    );
  });
  if (index > state.max - state.min) {
    throw new BrowserCompanionError(`ChatGPT effort slider does not expose index ${index}`, "model_unavailable");
  }
  if (!state.available[index]) {
    throw new BrowserCompanionError("ChatGPT locks the requested effort for this account", "model_unavailable");
  }
  return state;
}

export async function selectModelAndEffort(
  page: Page,
  model: string,
  effort: string,
  capabilities: AccountCapabilities,
  signal?: AbortSignal,
): Promise<SelectedBrowserModel> {
  const resolved = resolveBrowserModel(model, effort, capabilities);
  const composer = await activeComposer(page, 30_000, signal);
  const form = composer.locator("xpath=ancestor::form[1]");
  const controls = form.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible:true });
  if (resolved.effortIndex === null) {
    if (await controls.count() > 0) {
      throw new BrowserCompanionError("ChatGPT account changed from Luna-only to Sol during selection", "model_unavailable");
    }
    await setLunaThinkMode(composer, resolved.lunaThink, signal);
    return { ...resolved, selection:null };
  }
  await controls.first().waitFor({ state:"visible", timeout:70_000, signal });
  if (await controls.count() !== 1) {
    throw new BrowserCompanionError("ChatGPT did not expose one model/effort control", "model_unavailable");
  }
  const control = controls.first();
  let menu = await activateChatGptEffortMenu(page, control);
  menu = await selectChatGptModelFamily(menu, resolved.family!, () => activateChatGptEffortMenu(page, control));
  let slider = await availableEffort(menu, resolved.effortIndex);
  const origin = slider.min;
  const target = origin + resolved.effortIndex;
  const sliderControl = menu.slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
  while (slider.value !== target) {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    const direction = target > slider.value ? 1 : -1;
    const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
    const before = slider.value;
    await sliderControl.press(key, { timeout:5_000, signal });
    const deadline = Date.now() + 5_000;
    do {
      slider = await availableEffort(menu, resolved.effortIndex);
      if (slider.min !== origin) throw new BrowserCompanionError("ChatGPT changed its effort range", "model_unavailable");
      if (slider.value !== before) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    if (slider.value !== before + direction) {
      throw new BrowserCompanionError(`ChatGPT effort slider did not move one step with ${key}`, "model_unavailable");
    }
  }
  const selectedUrl = page.url();
  await page.keyboard.press("Escape");
  const label = (await control.innerText()).trim();
  if (!label || await control.getAttribute("aria-expanded") !== "false") {
    throw new BrowserCompanionError("ChatGPT did not close the model picker with a selected effort", "model_unavailable");
  }
  const confirmation = await activateChatGptEffortMenu(page, control);
  const confirmed = await availableEffort(confirmation, resolved.effortIndex);
  if (confirmed.min !== origin || confirmed.value !== target) {
    throw new BrowserCompanionError("ChatGPT did not persist the requested effort", "model_unavailable");
  }
  await assertChatGptModelFamily(confirmation, resolved.family!, resolved.effort, resolved.effortIndex, 1_000);
  await page.keyboard.press("Escape");
  return { ...resolved, selection:{ url:selectedUrl, label } };
}

export async function assertSelectedModelAndEffort(
  page: Page,
  selected: SelectedBrowserModel,
  signal?: AbortSignal,
): Promise<void> {
  const composer = await activeComposer(page, 30_000, signal);
  if (selected.effortIndex === null) {
    await setLunaThinkMode(composer, selected.lunaThink, signal);
    return;
  }
  if (!selected.selection || page.url() !== selected.selection.url) {
    throw new BrowserCompanionError("ChatGPT changed the selected conversation before Send", "external_interference");
  }
  const controls = composer.locator("xpath=ancestor::form[1]")
    .locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible:true });
  if (await controls.count() !== 1) throw new BrowserCompanionError("ChatGPT model control changed before Send", "model_unavailable");
  const control = controls.first();
  if ((await control.innerText()).trim() !== selected.selection.label
    || await control.getAttribute("aria-expanded") !== "false") {
    throw new BrowserCompanionError("ChatGPT did not retain the selected model and effort", "external_interference");
  }
  const menu = await activateChatGptEffortMenu(page, control);
  try {
    await assertChatGptModelFamily(menu, selected.family!, selected.effort, selected.effortIndex);
  } finally {
    await page.keyboard.press("Escape");
  }
}
