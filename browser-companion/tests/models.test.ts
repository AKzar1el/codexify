import { expect, test } from "bun:test";
import {
  buildCapabilityCatalog,
  resolveBrowserModel,
  type AccountCapabilities,
} from "../src/models";

const account = (overrides: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
  ...overrides,
});

test("Luna-only accounts expose only Luna and Think without pretending Sol exists", () => {
  const catalog = buildCapabilityCatalog(account({ solAvailable: false, extraHighAvailable: false, proAvailable: false }), "account-a");
  expect(catalog.models).toEqual([{
    id: "gpt-5.6-luna",
    label: "Luna",
    efforts: [
      { id: "low", label: "Luna", available: true, reason: null },
      { id: "medium", label: "Think", available: true, reason: null },
    ],
  }]);
  expect(catalog.accountFingerprint).toBe("account-a");
  expect(catalog.catalogRevision).toMatch(/^[0-9a-f]{64}$/);
});

test("Sol accounts expose stable model IDs and preserve locked effort evidence", () => {
  const catalog = buildCapabilityCatalog(account({ extraHighAvailable: false, proAvailable: true }), "account-b");
  expect(catalog.models.map(model => model.id)).toEqual(["gpt-5.6-sol", "gpt-6-sol"]);
  for (const model of catalog.models) {
    expect(model.efforts.map(effort => [effort.id, effort.available])).toEqual([
      ["low", true], ["medium", true], ["high", true], ["xhigh", false], ["max", true],
    ]);
    expect(model.efforts[3]?.reason).toBe("not_available_for_account");
  }
});

test("route resolution refuses unavailable effort or cross-family invention", () => {
  expect(resolveBrowserModel("gpt-6-sol", "high", account())).toEqual({
    id: "gpt-6-sol", family: "6", effort: "high", effortIndex: 2, lunaThink: false,
  });
  expect(resolveBrowserModel("gpt-5.6-sol", "max", account())).toEqual({
    id: "gpt-5.6-sol", family: "5.6", effort: "max", effortIndex: 4, lunaThink: false,
  });
  expect(resolveBrowserModel("gpt-5.6-luna", "medium", account({ solAvailable: false }))).toEqual({
    id: "gpt-5.6-luna", family: null, effort: "medium", effortIndex: null, lunaThink: true,
  });
  expect(() => resolveBrowserModel("gpt-6-sol", "xhigh", account({ extraHighAvailable: false }))).toThrow("Extra High");
  expect(() => resolveBrowserModel("gpt-5.6-luna", "medium", account())).toThrow("Luna");
  expect(() => resolveBrowserModel("unknown", "high", account())).toThrow("not supported");
});
