import { expect, test } from "bun:test";
import { connectorSelectionSelector, normalizeConnectorRowTitles } from "../src/connector-selection";

test("selected connector selector matches only one exact configured identity", () => {
  expect(connectorSelectionSelector("Codexify")).toBe(
    '[data-id^="plugin:"][data-keyword="Codexify"], [app-mention-path^="app://"][app-mention-display-name="Codexify"][contenteditable="false"]',
  );
  expect(connectorSelectionSelector('Codexify "DEV"')).toContain('Codexify \\"DEV\\"');
  for (const value of ["", " ", "x\n", "x".repeat(257)]) {
    expect(() => connectorSelectionSelector(value)).toThrow("invalid");
  }
});

test("connector menu diagnostics retain titles but discard descriptions and blanks", () => {
  expect(normalizeConnectorRowTitles([
    "Codexify\nUse tools from Codexify",
    "  Codexify DEV  \nOther description",
    "\nDescription only",
    "",
  ])).toEqual(["Codexify", "Codexify DEV"]);
});
