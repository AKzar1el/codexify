import { expect, test } from "bun:test";
import { browserEffortIdFromLabel } from "../src/models";
import { chatGptModelFamilyMatches, chatGptModelSelectionMatches, selectChatGptModelFamily } from "../src/model-selection";

test("model family selection recognizes only the exact supported UI rows", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true], ["6", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count:async () => 1, getAttribute:async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation requires exact version, Sol/Astra mode, and Pro semantics", () => {
  expect(chatGptModelFamilyMatches(["GPT-5.5 Sol Pro, 5 of 5."], "5.5", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["GPT-5.5 High, 3 of 5."], "5.5", "high")).toBeTrue();
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBeTrue();
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBeFalse();
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBeFalse();
  expect(chatGptModelFamilyMatches(["6 Sol Pro, 5 of 5."], "6", "max")).toBeFalse();
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], "6", "max")).toBeFalse();
});

test("GPT-5.5 remains selectable when its retirement notice is part of the radio name", async () => {
  for (const label of ["GPT-5.5", "GPT-5.5 Sol", "GPT-5.5Leaving on October 14", "GPT-5.5 Leaving on October 14"]) {
    const menu = { menu:{
      getByRole: (_role: string, options: { name:RegExp }) => ({
        count:async () => options.name.test(label) ? 1 : 0,
        getAttribute:async () => "true",
      }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    expect(await selectChatGptModelFamily(menu, "5.5", async () => menu)).toBe(menu);
  }
});

test("effort-only announcements use the checked family without overriding explicit version evidence", () => {
  const current = ["Pro, 5 of 5.", "Use Left and Right arrow keys to adjust power", "Pro"];
  expect(chatGptModelSelectionMatches(current, "6", "max", true, "GPT-6")).toBeTrue();
  expect(chatGptModelSelectionMatches(current, "6", "max", false, "GPT-6")).toBeFalse();
  expect(chatGptModelSelectionMatches(current, "6", "high", true, "GPT-6")).toBeFalse();
  expect(chatGptModelSelectionMatches(current, "6", "max", true, "Latest")).toBeFalse();
  expect(chatGptModelSelectionMatches(["High, 3 of 5.", "High"], "5.5", "high", true, "GPT-5.5Leaving on October 14")).toBeTrue();
  expect(chatGptModelSelectionMatches(["GPT-5.6 Sol Pro, 5 of 5."], "6", "max", true, "GPT-6")).toBeFalse();
  expect(chatGptModelSelectionMatches(["Use Left and Right arrow keys to adjust power"], "6", "high", true, "GPT-6")).toBeFalse();
});


test("newly discovered effort labels can be verified without accepting the wrong selected effort", () => {
  const id = browserEffortIdFromLabel("Deep");
  expect(chatGptModelSelectionMatches(["Deep, 2 of 3.", "Deep"], "5.5", id, true, "GPT-5.5")).toBeTrue();
  expect(chatGptModelSelectionMatches(["Balanced, 2 of 3.", "Balanced"], "5.5", id, true, "GPT-5.5")).toBeFalse();
  expect(chatGptModelFamilyMatches(["5.6 Medium, 2 of 5."], "5.6", "high")).toBeFalse();
});
