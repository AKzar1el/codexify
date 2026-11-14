//! Recognize genuine ChatGPT generation controls across current picker layouts.
//! Adapted from LeZergan/codexify PR #22; no invasive browser pooling.
import type {Page, Locator} from "patchright";
import {CHATGPT_STOP_BUTTON_SELECTOR} from "./session";
import {uiLabelPattern} from "./ui-localization";

export const END_TURN_CONTROL_NAME = /^End(?: this| current)? turn$/iu;

export function stopControls(page: Page): Locator {
  return page.locator(CHATGPT_STOP_BUTTON_SELECTOR)
    .or(page.getByRole("button", {name:uiLabelPattern("stopControl")}))
    .or(page.getByRole("button", {name:END_TURN_CONTROL_NAME}))
    .filter({visible:true});
}
