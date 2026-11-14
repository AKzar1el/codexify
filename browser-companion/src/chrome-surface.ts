// Replaces the Electron/CDP surface adapted from miuuyy/codex-chatgpt-web
// launcher/electron/browser-host.cjs at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import type { SingleBrowserSurface } from "./chatgpt-driver";
import { BrowserCompanionError } from "./errors";
import { backgroundChromeArgs } from "./background-chrome";
import {prepareRequestBlockList,requestBlockListArgs,verifyRequestBlockList} from "./request-block-list";
import {assertConversationLoadSlot,isChatGptPage,navigatePage,observeConversationLoadResponses} from "./navigation";
import {installChatModeCompatibility} from "./chat-mode";
import {canonicalChatGptConversationUrl,validateChatGptConversationUrl} from "./protocol";

const CHATGPT_HOME = "https://chatgpt.com/";

export interface ChromeSurfaceOptions {
  profilePath: string;
  executablePath: string;
  requestBlockList?: readonly string[];
}

export class ChromeSingleWindowSurface implements SingleBrowserSurface {
  readonly closed: Promise<void>;
  private contextClosed = false;
  private actionActive = false;
  private selectedPage:Page;
  private draftPage?:Page;
  private static readonly MAX_TABS=32;

  private constructor(private readonly context: BrowserContext, private readonly controlPage: Page) {
    this.selectedPage=controlPage;
    this.closed = new Promise(resolveClosed => {
      const closed = () => { this.contextClosed = true; resolveClosed(); };
      context.once("close", closed);
      const pageClosed = () => {
        // Closing the last window can leave Chrome's background process alive.
        // Let the launcher exit so the next action can start a fresh window.
        if (context.pages().every(page => page.isClosed())) closed();
      };
      controlPage.once("close", pageClosed);
      context.on("page", page => page.once("close", pageClosed));
    });
  }

  private static async backgroundTab(context:BrowserContext,newWindow=false):Promise<Page> {
    const browser=context.browser();
    if(!browser)throw new Error("Persistent Chrome did not expose its browser connection");
    const session=await browser.newBrowserCDPSession();
    try {
      const [page]=await Promise.all([
        context.waitForEvent("page"),
        session.send("Target.createTarget",{
          url:"about:blank",background:true,...(newWindow?{newWindow:true}:{}),
        }),
      ]);
      observeConversationLoadResponses(page);
      return page;
    } finally { await session.detach(); }
  }

  private async newTab():Promise<Page> {
    if(this.contextClosed)throw new BrowserCompanionError("The ChatGPT browser was closed","external_interference");
    if(this.context.pages().filter(page=>!page.isClosed()).length>=ChromeSingleWindowSurface.MAX_TABS)
      throw new BrowserCompanionError("The browser has reached its safe 32-tab limit; close unused tabs before creating more","external_interference");
    return ChromeSingleWindowSurface.backgroundTab(this.context);
  }

  private static conversationKey(url:string):string|null {
    try {
      validateChatGptConversationUrl(url);
      const pathname=new URL(url).pathname;
      if(!/^\/(?:g\/[^/]+\/)?c\/[^/]+\/?$/.test(pathname)
        || /\/c\/local-chatgpt(?::|%3a)/i.test(pathname))return null;
      return canonicalChatGptConversationUrl(url);
    }catch{return null;}
  }

  static async create(options: ChromeSurfaceOptions): Promise<ChromeSingleWindowSurface> {
    const profilePath = resolve(options.profilePath);
    await mkdir(profilePath, { recursive:true, mode:0o700 });
    const policy=await prepareRequestBlockList(profilePath,options.requestBlockList||[]);
    const context = await chromium.launchPersistentContext(profilePath, {
      channel:"chrome",
      executablePath:resolve(options.executablePath),
      headless:false,
      viewport:null,
      ignoreDefaultArgs:true,
      args:requestBlockListArgs(await backgroundChromeArgs(profilePath),policy),
      // Keep Chrome's own browser headers and user agent.
    });
    try {
      await context.addInitScript(installChatModeCompatibility);
      await verifyRequestBlockList(context,policy);
      // Preserve all restored ChatGPT conversations. The old single-tab code
      // closed them and reused the same page for every goal, interrupting other
      // conversations even though their local worktrees were independent.
      for(const page of context.pages())observeConversationLoadResponses(page);
      let control=context.pages().find(page=>!page.isClosed()&&page.url()==="about:blank");
      if(!control)control=await ChromeSingleWindowSurface.backgroundTab(context,context.pages().length===0);
      const surface=new ChromeSingleWindowSurface(context,control);
      if(!isChatGptPage(control.url()))await surface.navigate(CHATGPT_HOME);
      else await control.evaluate(installChatModeCompatibility,undefined,undefined,false);
      // The managed Windows browser is a background automation surface. Keep
      // newly launched Chrome windows out of the user's foreground desktop.
      // An explicit owner reveal() restores the window for interactive use.
      await surface.minimizeManagedWindow();
      return surface;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  async page(): Promise<Page> {
    if(this.contextClosed||this.selectedPage.isClosed()||!this.context.pages().includes(this.selectedPage))
      throw new BrowserCompanionError("The selected ChatGPT tab was closed or replaced","external_interference");
    return this.selectedPage;
  }

  async utilityPage():Promise<Page> {
    if(this.contextClosed||this.controlPage.isClosed())
      throw new BrowserCompanionError("The ChatGPT utility tab was closed","external_interference");
    return this.controlPage;
  }

  async selectUtilityPage():Promise<Page> {
    this.selectedPage=await this.utilityPage();
    return this.selectedPage;
  }

  async newChatPage():Promise<Page> {
    if(!this.draftPage||this.draftPage.isClosed()
      ||ChromeSingleWindowSurface.conversationKey(this.draftPage.url())){
      this.draftPage=await this.newTab();
    }
    this.selectedPage=this.draftPage;
    return this.page();
  }

  async selectConversation(url:string,signal?:AbortSignal):Promise<Page> {
    if(signal?.aborted)throw new DOMException("Browser action aborted","AbortError");
    const key=ChromeSingleWindowSurface.conversationKey(url);
    if(!key)throw new BrowserCompanionError("A goal tab requires an exact ChatGPT conversation URL","conversation_unavailable");
    const matches=this.context.pages().filter(page=>!page.isClosed()
      &&ChromeSingleWindowSurface.conversationKey(page.url())===key);
    if(matches.length>1)throw new BrowserCompanionError("Multiple tabs show the same ChatGPT conversation; select a unique target","external_interference");
    if(matches.length===1){this.selectedPage=matches[0]!;return this.page();}
    const previous=await this.page();
    // A cooldown rejection must never flash a blank tab before closing it.
    // Bypass remains available only for explicitly authorized manual Retry.
    assertConversationLoadSlot(previous,url);
    const page=await this.newTab();
    this.selectedPage=page;
    try {
      await navigatePage(page,url,{signal});
      return page;
    }catch(error) {
      // A global conversation-load cooldown may refuse navigation before any
      // document is loaded. Do not strand blank goal tabs on every retry.
      if(!page.isClosed())await page.close().catch(()=>{});
      this.selectedPage=previous;
      throw error;
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<Page> {
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error("Browser window navigation requires HTTPS");
    const page=ChromeSingleWindowSurface.conversationKey(target.href)
      ?await this.selectConversation(target.href,signal)
      :await this.page();
    if(ChromeSingleWindowSurface.conversationKey(target.href)
      &&ChromeSingleWindowSurface.conversationKey(page.url())===ChromeSingleWindowSurface.conversationKey(target.href))
      return page;
    await navigatePage(page,target.href,{signal});
    if (signal?.aborted) throw new DOMException("Browser action aborted", "AbortError");
    await page.waitForLoadState("domcontentloaded", { timeout:30_000,signal }).catch(error => { if(signal?.aborted)throw error; });
    return page;
  }

  private async minimizeManagedWindow():Promise<void> {
    if(process.platform!=="win32")return;
    let session:Awaited<ReturnType<BrowserContext["newCDPSession"]>>|undefined;
    try {
      session=await this.context.newCDPSession(this.controlPage);
      const window=await session.send("Browser.getWindowForTarget");
      if(window.bounds.windowState!=="minimized")
        await session.send("Browser.setWindowBounds",{
          windowId:window.windowId,bounds:{windowState:"minimized"},
        });
    } catch {
      // A desktop/window-manager that does not support minimizing must not
      // break authenticated automation or silently close user goal tabs.
    } finally {
      await session?.detach().catch(()=>{});
    }
  }

  async reveal(): Promise<void> {
    const page = await this.page();
    const session = await this.context.newCDPSession(page);
    try {
      const window = await session.send("Browser.getWindowForTarget");
      if (window.bounds.windowState === "minimized") {
        await session.send("Browser.setWindowBounds", { windowId:window.windowId, bounds:{ windowState:"normal" } });
      }
    } finally {
      await session.detach();
    }
    await page.bringToFront();
  }

  async beginAction(): Promise<void> {
    if (this.actionActive) throw new Error("The shared browser window already owns an action");
    await this.page();
    this.actionActive = true;
  }

  async endAction(): Promise<void> {
    this.actionActive = false;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
