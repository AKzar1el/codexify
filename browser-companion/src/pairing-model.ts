import type { Page } from "patchright";
import { activeComposer } from "./composer";
import { BrowserCompanionError } from "./errors";
import { browserModelFamilyFromLabel } from "./models";
import {
  CHATGPT_EFFORT_CONTROL_SELECTOR, activateChatGptEffortMenu, discoverChatGptEfforts,
  moveChatGptEffortSlider, readChatGptEffortSnapshot, readCurrentEffortLabel,
} from "./session";

export interface PairingMediumSelection {
  verify(signal: AbortSignal): Promise<void>;
  restore(signal: AbortSignal): Promise<void>;
}

const normalize = (label: string) => label.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();

/** The pairing turn borrows Medium; neither the model family nor saved preferences are changed. */
export async function selectPairingMedium(page: Page, signal: AbortSignal): Promise<PairingMediumSelection> {
  const composer = await activeComposer(page, 10_000, signal);
  const controls = composer.locator("xpath=ancestor::form[1]")
    .locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
  await controls.first().waitFor({state:"visible", timeout:10_000, signal});
  if (await controls.count() !== 1) throw new BrowserCompanionError("Pairing requires one verifiable Medium control; the request was not sent", "model_unavailable");
  const control = controls.first();
  const checkedFamily = async (menu: Awaited<ReturnType<typeof activateChatGptEffortMenu>>) => {
    const labels = await menu.menu.getByRole("menuitemradio", {includeHidden:true}).evaluateAll(elements =>
      elements.filter(element => element.getAttribute("aria-checked") === "true").map(element => element.textContent ?? ""));
    if (labels.length !== 1 || !normalize(labels[0]!)) throw new BrowserCompanionError("ChatGPT did not identify the pairing request's model family", "model_unavailable");
    return browserModelFamilyFromLabel(labels[0]!) ?? normalize(labels[0]!);
  };
  let menu = await activateChatGptEffortMenu(page, control);
  let original: Awaited<ReturnType<typeof readChatGptEffortSnapshot>>;
  let family: string;
  let label: string;
  try {
    original = await readChatGptEffortSnapshot(menu.sliderContainer);
    family = await checkedFamily(menu);
    label = await readCurrentEffortLabel(menu);
  } catch (error) { await page.keyboard.press("Escape").catch(() => {}); throw error; }
  let target: number | undefined;
  let mediumSelected = false;
  const inspect = async () => {
    menu = await activateChatGptEffortMenu(page, control);
    const state = await readChatGptEffortSnapshot(menu.sliderContainer);
    if (await checkedFamily(menu) !== family || state.min !== original.min || state.max !== original.max) {
      throw new BrowserCompanionError("ChatGPT changed the model family or effort range during pairing", "external_interference");
    }
    return {state, label:await readCurrentEffortLabel(menu)};
  };
  const restore = async (restoreSignal: AbortSignal) => {
    try {
      const current = await inspect();
      if (current.state.value === original.value && normalize(current.label) === normalize(label)) return;
      if (mediumSelected && (current.state.value !== target || normalize(current.label).toLowerCase() !== "medium")) {
        throw new BrowserCompanionError("ChatGPT changed the temporary pairing selection; it was not overwritten", "external_interference");
      }
      await moveChatGptEffortSlider(menu, original.value, restoreSignal);
      const restored = await inspect();
      if (restored.state.value !== original.value || normalize(restored.label) !== normalize(label)) {
        throw new BrowserCompanionError("ChatGPT did not restore the conversation's model and effort after pairing", "model_unavailable");
      }
    } finally { await page.keyboard.press("Escape").catch(() => {}); }
  };
  try {
    let index = original.labels.findIndex(value => value && normalize(value).toLowerCase() === "medium");
    if (index < 0) {
      const efforts = await discoverChatGptEfforts(menu);
      index = efforts.find(effort => normalize(effort.label).toLowerCase() === "medium")?.index ?? -1;
    }
    if (index < 0 || !original.available[index]) {
      throw new BrowserCompanionError("Medium mode is unavailable for pairing; the pairing request was not sent", "model_unavailable");
    }
    target = original.min + index;
    await moveChatGptEffortSlider(menu, target, signal);
    const verify = async (verifySignal: AbortSignal) => {
      if (verifySignal.aborted) throw new DOMException("Browser action aborted", "AbortError");
      try {
        const current = await inspect();
        if (current.state.value !== target || normalize(current.label).toLowerCase() !== "medium") {
          throw new BrowserCompanionError("ChatGPT did not retain Medium mode for the pairing request", "model_unavailable");
        }
      } finally { await page.keyboard.press("Escape").catch(() => {}); }
    };
    await verify(signal);
    mediumSelected = true;
    return {verify, restore};
  } catch (error) {
    await restore(AbortSignal.timeout(10_000));
    throw error;
  }
}
