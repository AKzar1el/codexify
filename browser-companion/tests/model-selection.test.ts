import { expect, test } from "bun:test";
import { chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/model-selection";

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
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBeTrue();
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBeFalse();
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBeFalse();
  expect(chatGptModelFamilyMatches(["6 Sol Pro, 5 of 5."], "6", "max")).toBeFalse();
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], "6", "max")).toBeFalse();
});
