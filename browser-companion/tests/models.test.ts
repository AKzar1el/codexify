import { expect, test } from "bun:test";
import { buildCapabilityCatalog, browserEffortIdFromLabel, browserModelFamilyFromLabel, modelsFromDiscoveredEfforts, resolveBrowserModel, type AccountCapabilities, type BrowserModelFamily, type DiscoveredBrowserEffort } from "../src/models";

const observed = (labels: readonly string[], locked: readonly number[] = []): DiscoveredBrowserEffort[] => labels.map((label, index) => ({
  id:browserEffortIdFromLabel(label), label, index, available:!locked.includes(index), reason:locked.includes(index) ? "not_available_for_account" : null,
}));
const account = (family: BrowserModelFamily, labels: readonly string[], locked: readonly number[] = []): AccountCapabilities => ({ models:modelsFromDiscoveredEfforts(family, observed(labels, locked)) });

test("catalogs contain only observed efforts, including new labels and different orders", () => {
  const capabilities = account("5.5", ["Deep", "Instant", "Balanced"]);
  const catalog = buildCapabilityCatalog(capabilities, "account-a");
  expect(catalog.models.map(model => [model.label, model.efforts.map(effort => effort.label)])).toEqual([["GPT-5.5", ["Deep", "Instant", "Balanced"]]]);
  expect(catalog.models[0]!.efforts.some(effort => effort.id === "max")).toBeFalse();
  expect(resolveBrowserModel("gpt-5.5-sol", "low", capabilities).effortIndex).toBe(1);
  expect(resolveBrowserModel("gpt-5.5-sol", browserEffortIdFromLabel("Deep"), capabilities).effortIndex).toBe(0);
  expect(catalog.accountFingerprint).toBe("account-a");
  expect(catalog.catalogRevision).toMatch(/^[0-9a-f]{64}$/);
  expect(() => buildCapabilityCatalog({models:[]}, "account-a")).toThrow();
});

test("family-specific availability is preserved and unobserved efforts are never added", () => {
  const capabilities: AccountCapabilities = { models:[
    ...account("6", ["Instant", "High", "Pro"], [1]).models,
    ...account("5.5", ["Medium", "Extra High"]).models,
  ] };
  const catalog = buildCapabilityCatalog(capabilities, "account-b");
  expect(catalog.models.map(model => [model.label, model.efforts.map(effort => [effort.label, effort.available])])).toEqual([
    ["GPT-6 Astra", [["Pro", true]]], ["GPT-6", [["Instant", true], ["High", false]]], ["GPT-5.5", [["Medium", true], ["Extra High", true]]],
  ]);
  expect(resolveBrowserModel("gpt-6-astra", "max", capabilities).effortIndex).toBe(2);
  expect(() => resolveBrowserModel("gpt-6-sol", "max", capabilities)).toThrow("not discovered");
  expect(() => resolveBrowserModel("gpt-6-astra", "high", capabilities)).toThrow("not discovered");
  expect(() => resolveBrowserModel("gpt-6-sol", "high", capabilities)).toThrow("not available");
  expect(() => resolveBrowserModel("gpt-5.5-sol", "max", capabilities)).toThrow("not discovered");
  expect(() => resolveBrowserModel("gpt-5.6-sol", "high", capabilities)).toThrow("not discovered");
  expect(() => resolveBrowserModel("__proto__", "high", capabilities)).toThrow("not discovered");
});

test("only an observed GPT-6 Pro effort creates the Astra naming exception", () => {
  expect(account("6", ["Instant", "Turbo"]).models.map(model => model.label)).toEqual(["GPT-6"]);
  expect(account("6", ["Pro"]).models.map(model => model.label)).toEqual(["GPT-6 Astra"]);
  expect(account("5.6", ["Pro"]).models.map(model => model.label)).toEqual(["GPT-5.6"]);
});

test("verified plans name otherwise unnamed models without changing IDs or efforts", () => {
  const capabilities: AccountCapabilities = {models:[...account("6", ["Instant", "High", "Pro"]).models, ...account("5.5", ["Medium"]).models]};
  for (const [planKind, suffix] of [["pro", " Sol"], ["free", " Luna"], ["go", " Luna"], ["unknown", ""]] as const) {
    const catalog = buildCapabilityCatalog(capabilities, "account-plan", undefined, planKind);
    expect(catalog.models.map(model => model.label)).toEqual(["GPT-6 Astra", `GPT-6${suffix}`, `GPT-5.5${suffix}`]);
    expect(catalog.models.map(model => [model.id, model.efforts.map(effort => effort.id)])).toEqual([
      ["gpt-6-astra", ["max"]], ["gpt-6-sol", ["low", "high"]], ["gpt-5.5-sol", ["medium"]],
    ]);
  }
  const observedNames = {models:modelsFromDiscoveredEfforts("5.6", observed(["High"]), "GPT-5.6 Luna")};
  expect(buildCapabilityCatalog(observedNames, "observed", undefined, "pro").models[0]!.label).toBe("GPT-5.6 Luna");
});

test("supported model rows include GPT-5.5's retirement notice", () => {
  expect(["GPT-6", "GPT-5.6", "GPT-5.5Leaving on October 14"].map(browserModelFamilyFromLabel)).toEqual(["6", "5.6", "5.5"]);
  expect(browserModelFamilyFromLabel("GPT-5.5 Preview")).toBeUndefined();
});
