import { afterEach, expect, test } from "bun:test";
import { insertPlainTextIntoComposer, isPairingVerificationDraft, verifyOwnedComposerText } from "../src/composer";
import { renderActionPrompt } from "../src/protocol";

interface FakeSelection {
  isCollapsed: boolean;
  anchorNode: object | null;
  removeAllRanges(): void;
  addRange(range: object): void;
}

const originals = { document: globalThis.document, window: globalThis.window };
afterEach(() => {
  (globalThis as Record<string, unknown>).document = originals.document;
  (globalThis as Record<string, unknown>).window = originals.window;
});

function harness(options: {
  focusable: boolean;
  caretInsideComposer: boolean;
  collapsed?: boolean;
  execCommandResult?: boolean;
}) {
  const inside = { name:"inside" };
  const composer = {
    focus() { if (options.focusable) fakeDocument.activeElement = composer; },
    contains: (node: object | null) => node === inside || node === composer,
  };
  const calls: Array<{ command:string; value:string }> = [];
  const selection: FakeSelection = {
    isCollapsed: options.collapsed ?? true,
    anchorNode: options.caretInsideComposer ? inside : { name:"outside" },
    removeAllRanges() { selection.anchorNode = null; },
    addRange() { selection.anchorNode = inside; selection.isCollapsed = true; },
  };
  const fakeDocument = {
    activeElement: null as unknown,
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command: string, _ui: boolean, value: string) {
      calls.push({ command, value });
      return options.execCommandResult ?? true;
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = { getSelection: () => selection };
  return { composer:composer as unknown as HTMLElement, calls, selection };
}

test("exact plaintext insertion establishes a caret only inside the owned composer", () => {
  const { composer, calls, selection } = harness({ focusable:true, caretInsideComposer:false });
  expect(insertPlainTextIntoComposer(composer, "line one\nline two")).toBeTrue();
  expect(calls).toEqual([{ command:"insertText", value:"line one\nline two" }]);
  expect(selection.isCollapsed).toBeTrue();
});

test("insertion refuses a detached or covered composer and reports rejected edits", () => {
  expect(insertPlainTextIntoComposer(harness({ focusable:false, caretInsideComposer:false }).composer, "x")).toBeFalse();
  expect(insertPlainTextIntoComposer(harness({ focusable:true, caretInsideComposer:true, execCommandResult:false }).composer, "x")).toBeFalse();
});

test("composer verification preserves exact whitespace and rejects connector-only or stale drafts", () => {
  expect(verifyOwnedComposerText("Prompt\nwith  two spaces", "Prompt\nwith  two spaces")).toBeTrue();
  expect(verifyOwnedComposerText("Prompt with two spaces", "Prompt with  two spaces")).toBeFalse();
  expect(verifyOwnedComposerText("Codexify", "")).toBeFalse();
  expect(verifyOwnedComposerText("old request", "new request")).toBeFalse();
});

test("pairing replacement recognizes only the complete unchanged verification template", () => {
  const draft = renderActionPrompt({kind:"pair_verify",reference:"A".repeat(43)});
  expect(isPairingVerificationDraft(draft)).toBeTrue();
  const legacy = [
    "Verify that this ChatGPT conversation is paired with the intended Codexify task by",
    `calling \`automation_verify_pairing\` with the non-secret: ${"A".repeat(43)}`,
    "Do not inspect project files or perform task work in this verification turn.",
    "",
    draft.split("\n\n").at(-1),
  ].join("\n");
  expect(isPairingVerificationDraft(legacy)).toBeTrue();
  for (const text of ["my own draft", draft + " edited", legacy + " edited", draft.replace("Do not inspect", "Please inspect"), draft.replace("A".repeat(43), "short"), draft.replaceAll("\n", " ")]) {
    expect(isPairingVerificationDraft(text)).toBeFalse();
  }
});
