import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  activateChatGptEffortMenu,
  parseChatGptEffortSliderState,
  parseChatGptModelAnnouncement,
} from "../src/session";

test("composer and effort selectors exclude unrelated editors and menus", () => {
  const document = createDocument(`<body><form>
    <div contenteditable="true" id="unrelated-editor"></div>
    <button aria-haspopup="menu" id="attachments"></button>
    <div data-testid="prompt-textarea" id="composer-testid"></div>
    <div id="prompt-textarea"></div>
    <div contenteditable="true" data-lexical-editor="true" id="composer-lexical"></div>
    <button aria-haspopup="menu" data-tone="neutral" id="effort"></button>
    <button aria-haspopup="menu" data-testid="model-switcher-dropdown-button" id="model"></button>
  </form>
  <form data-chatgpt-composer>
    <div contenteditable="true" data-composer-markdown role="textbox" id="power-editor"></div>
    <button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" id="power-effort"></button>
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual(["composer-testid", "prompt-textarea", "composer-lexical", "power-editor"]);
  expect(matches(CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["effort", "model", "power-effort"]);
});

test("model announcements tolerate localized punctuation without weakening identity", () => {
  expect(parseChatGptModelAnnouncement("\u2068６ Pro\u2069、5 of 5")).toEqual({ version:"6", mode:"Pro" });
  expect(parseChatGptModelAnnouncement("GPT-5.6 Sol Extra High, 4 of 5")).toEqual({ version:"5.6", name:"sol", mode:"Extra High" });
  expect(parseChatGptModelAnnouncement("Try Pro for more reasoning")).toBeUndefined();
});

test("effort slider state is bounded and internally consistent", () => {
  expect(parseChatGptEffortSliderState("0", "4", "2")).toEqual({ min:0, max:4, value:2 });
  expect(parseChatGptEffortSliderState("0", "5", "2")).toBeUndefined();
  expect(parseChatGptEffortSliderState("0", "4", "5")).toBeUndefined();
  expect(parseChatGptEffortSliderState("x", "4", "2")).toBeUndefined();
});

test("effort activation retries a ghost click with primary pointerdown", async () => {
  let ghostOpen = false;
  let pointerOpened = false;
  const events: unknown[] = [];
  const ownedMenu = { isVisible: async () => pointerOpened };
  const hiddenSurface = {
    filter() { return this; }, last() { return this; }, locator() { return this; }, isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return pointerOpened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return ghostOpen ? "true" : "false";
      if (name === "data-state") return ghostOpen ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => { events.push(["click", options]); ghostOpen = true; },
    dispatchEvent: async (name: string, detail: unknown) => {
      events.push([name, detail]); ghostOpen = true; pointerOpened = true;
    },
  };
  const page = {
    locator: (selector: string) => selector === '[id="radix-effort-menu"]' ? ownedMenu : hiddenSurface,
    keyboard: { press: async (key: string) => { events.push(["keyboard", key]); ghostOpen = false; } },
  };
  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs:0 });
  expect(activation.method).toBe("pointerdown");
  expect(events).toEqual([
    ["click", { force:true, timeout:1 }],
    ["keyboard", "Escape"],
    ["pointerdown", { button:0, buttons:1, pointerType:"mouse", isPrimary:true }],
  ]);
});
