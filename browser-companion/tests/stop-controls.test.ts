import { expect, test } from "bun:test";
import type { Locator, Page } from "patchright";
import { stopControls, END_TURN_CONTROL_NAME } from "../src/stop-controls";
import { CHATGPT_STOP_BUTTON_SELECTOR } from "../src/session";

test("Stop recovery uses the known selector, localized button and End turn fallback", () => {
  const calls: string[] = [];
  const locator = {
    or(_other: Locator) { calls.push("or"); return locator; },
    filter(options: Record<string, unknown>) { calls.push("visible="+options.visible); return locator; },
  } as unknown as Locator;
  const page = {
    locator(selector: string) { calls.push("selector="+selector); return locator; },
    getByRole(role: string, options: {name: RegExp}) {
      calls.push("role="+role+" name="+options.name.source); return locator;
    },
  } as unknown as Page;
  expect(stopControls(page)).toBe(locator);
  expect(calls).toContain("selector="+CHATGPT_STOP_BUTTON_SELECTOR);
  expect(calls).toContain("role=button name="+END_TURN_CONTROL_NAME.source);
  expect(calls).toContain("visible=true");
  expect(calls.filter(value => value === "or").length).toBe(2);
});

test("End turn fallback matches only explicit end-turn labels", () => {
  for (const label of ["End turn", "End this turn", "End current turn"])
    expect(END_TURN_CONTROL_NAME.test(label)).toBe(true);
  for (const label of ["Send", "Queue", "End session", "Delete conversation"])
    expect(END_TURN_CONTROL_NAME.test(label)).toBe(false);
});