import { expect, test } from "bun:test";
import type { Page } from "patchright";
import {
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


test("a Chrome page closed during health inspection is unavailable rather than signed out",async()=>{
  class ClosingSurface extends UnavailableSurface {
    override async page():Promise<Page>{return {isClosed:()=>true,locator:()=>{throw new Error("Target closed");}} as unknown as Page;}
  }
  const driver=new ChatGptBrowserDriver(new ClosingSurface(),protocolBuild("test-build"));
  const health=await driver.health();expect(health.status).toBe("unavailable");expect(health.authenticated).toBeFalse();
  expect(health.detail).not.toContain("authentication");
});
