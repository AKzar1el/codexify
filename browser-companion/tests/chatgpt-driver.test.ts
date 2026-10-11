import { expect, test } from "bun:test";
import type { Page } from "patchright";
import {
  assertCapabilityAccount,
  ChatGptBrowserDriver,
  type SingleBrowserSurface,
} from "../src/chatgpt-driver";
import { BrowserCompanionError } from "../src/errors";
import { protocolBuild } from "../src/protocol";

class UnavailableSurface implements SingleBrowserSurface {
  async page(): Promise<Page> {
    throw new BrowserCompanionError("The shared ChatGPT window was destroyed", "external_interference");
  }

  async navigate(): Promise<Page> {
    return this.page();
  }

  async reveal(): Promise<void> {}
  async beginAction(): Promise<void> {}
  async endAction(): Promise<void> {}
  async close(): Promise<void> {}
}

test("browser infrastructure failures are unavailable rather than authentication failures", async () => {
  const driver = new ChatGptBrowserDriver(new UnavailableSurface(), protocolBuild("test-build"));

  await expect(driver.health()).resolves.toEqual({
    authenticated:false,
    accountFingerprint:null,
    status:"unavailable",
    detail:"The shared ChatGPT window was destroyed",
  });
});

test("a browser action refuses a capability cache from another account", () => {
  expect(() => assertCapabilityAccount({ accountFingerprint:"account-one" }, "account-one"))
    .not.toThrow();
  expect(() => assertCapabilityAccount(undefined, "account-one")).toThrow(
    "Refresh browser capabilities",
  );
  expect(() => assertCapabilityAccount({ accountFingerprint:"account-one" }, "account-two"))
    .toThrow(
    "ChatGPT account changed",
  );
});
