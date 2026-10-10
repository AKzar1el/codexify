// Adapted from miuuyy/codex-chatgpt-web launcher/electron/browser-host.cjs and
// src/launcher-browser-host.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { chromium, type Browser, type Page } from "playwright-core";
import type { SingleBrowserSurface } from "./chatgpt-driver";
import { BrowserCompanionError } from "./errors";

const CHATGPT_HOME = "https://chatgpt.com/";
const CDP_CONNECT_TIMEOUT_MS = 30_000;

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a browser debugging port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

export interface ElectronSurfaceOptions {
  profilePath: string;
  title?: string;
}

export class ElectronSingleWindowSurface implements SingleBrowserSurface {
  private window!: BrowserWindow;
  private browser!: Browser;
  private closing = false;
  private actionActive = false;

  private constructor(private readonly cdpPort: number) {}

  static async create(options: ElectronSurfaceOptions): Promise<ElectronSingleWindowSurface> {
    if (app.isReady()) throw new Error("Electron browser surface must configure CDP before app readiness");
    const profilePath = resolve(options.profilePath);
    app.setPath("userData", profilePath);
    const cdpPort = await reserveLoopbackPort();
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
    app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
    app.commandLine.appendSwitch("disable-features", "Translate,MediaRouter");
    await app.whenReady();

    const surface = new ElectronSingleWindowSurface(cdpPort);
    surface.window = new BrowserWindow({
      width:1180,
      height:820,
      minWidth:720,
      minHeight:560,
      show:false,
      title:options.title ?? "Codexify ChatGPT",
      autoHideMenuBar:true,
      webPreferences:{
        partition:"persist:codexify-chatgpt",
        nodeIntegration:false,
        contextIsolation:true,
        sandbox:true,
        backgroundThrottling:false,
        spellcheck:true,
      },
    });
    surface.window.on("close", event => {
      if (surface.closing) return;
      event.preventDefault();
      surface.window.hide();
    });
    surface.window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.protocol === "https:") {
          setImmediate(() => { void surface.window.loadURL(target.href); });
        } else {
          void shell.openExternal(url);
        }
      } catch {
        // Invalid window-open targets are ignored rather than handed to the OS.
      }
      return { action:"deny" };
    });
    surface.window.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).protocol === "https:") return;
      } catch {
        // Fall through to blocking malformed navigation.
      }
      event.preventDefault();
    });
    await surface.window.loadURL(CHATGPT_HOME);
    surface.browser = await surface.connectCdp();
    await surface.page();
    return surface;
  }

  async page(): Promise<Page> {
    if (this.window.isDestroyed()) throw new BrowserCompanionError("The shared ChatGPT window was destroyed", "external_interference");
    const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
    for (;;) {
      const contexts = this.browser.contexts();
      const pages = contexts.flatMap(context => context.pages()).filter(page => !page.isClosed());
      if (pages.length === 1) return pages[0]!;
      if (pages.length > 1) {
        const expected = this.window.webContents.getURL();
        const matching = pages.filter(page => page.url() === expected);
        if (matching.length === 1) return matching[0]!;
        throw new BrowserCompanionError(`Electron exposed ${pages.length} browser pages for one shared window`, "external_interference");
      }
      if (Date.now() >= deadline) throw new Error("Electron ChatGPT page did not appear over CDP");
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<Page> {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error("Browser window navigation requires HTTPS");
    const page = await this.page();
    await page.goto(target.href, { waitUntil:"domcontentloaded", timeout:60_000 });
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    await page.waitForLoadState("domcontentloaded", { timeout:30_000 }).catch(() => {});
    return page;
  }

  async reveal(): Promise<void> {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  async beginAction(): Promise<void> {
    if (this.actionActive) throw new Error("The shared browser window already owns an action");
    this.actionActive = true;
    this.window.webContents.setBackgroundThrottling(false);
  }

  async endAction(): Promise<void> {
    this.actionActive = false;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.browser.close().catch(() => {});
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private async connectCdp(): Promise<Browser> {
    const endpoint = `http://127.0.0.1:${this.cdpPort}`;
    const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await chromium.connectOverCDP(endpoint, { timeout:5_000 });
      } catch (error) {
        lastError = error;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    }
    throw new Error("Could not attach Playwright to the Electron ChatGPT window", { cause:lastError });
  }
}
