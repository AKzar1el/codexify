// Replaces the Electron/CDP surface adapted from miuuyy/codex-chatgpt-web
// launcher/electron/browser-host.cjs at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import type { SingleBrowserSurface } from "./chatgpt-driver";
import { BrowserCompanionError } from "./errors";
import { backgroundChromeArgs } from "./background-chrome";
import {prepareRequestBlockList,requestBlockListArgs,verifyRequestBlockList} from "./request-block-list";
import {assertConversationLoadAvailableBeforeTab,isChatGptPage,navigatePage,observeConversationLoadResponses} from "./navigation";
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
  private static readonly MAX_TASK_TABS=16;
  private readonly taskSurfaces=new Map<string,Promise<ChromeSingleWindowSurface>>();
  private readonly delegatedPages=new Set<Page>();
  private taskTabCreationTail:Promise<void>=Promise.resolve();
  private onPageClosed?:()=>void;

  private constructor(
    private readonly context: BrowserContext,
    private readonly controlPage: Page,
    private readonly ownsContext=true,
    private readonly ownedPages?:Set<Page>,
    private readonly delegatedByParent?:Set<Page>,
    private readonly parentClosed?:Promise<void>,
    private readonly tabCreationGate:{tail:Promise<void>}={tail:Promise.resolve()},
  ) {
    this.selectedPage=controlPage;
    this.closed = new Promise(resolveClosed => {
      const closed = () => { this.contextClosed = true; resolveClosed(); };
      if(ownsContext)context.once("close", closed);
      else if(parentClosed)void parentClosed.then(closed);
      const pageClosed = () => {
        // Closing the last window can leave Chrome's background process alive.
        // Let the launcher exit so the next action can start a fresh window.
        if (ownedPages
          ? [...ownedPages].every(page => page.isClosed())
          : context.pages().every(page => page.isClosed())) closed();
      };
      this.onPageClosed=pageClosed;
      controlPage.once("close", pageClosed);
      if(ownsContext)context.on("page", page => page.once("close", pageClosed));
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
    let release!:()=>void;
    const wait=this.tabCreationGate.tail;
    const next=new Promise<void>(resolve=>{release=resolve;});
    this.tabCreationGate.tail=wait.then(()=>next,()=>next);
    await wait;
    try {
      if(this.context.pages().filter(page=>!page.isClosed()).length>=ChromeSingleWindowSurface.MAX_TABS)
        throw new BrowserCompanionError("The browser has reached its safe 32-tab limit; close unused tabs before creating more","external_interference");
      const page=await ChromeSingleWindowSurface.backgroundTab(this.context);
      this.ownedPages?.add(page);
      this.delegatedByParent?.add(page);
      if(!this.ownsContext&&this.onPageClosed)page.once("close",this.onPageClosed);
      return page;
    } finally { release(); }
  }

  /**
   * One authenticated Chrome profile, but a pinned page and independent
   * browser surface for each task. This is a building block for the future
   * multi-lane supervisor; the current two-lane routing stays unchanged.
   */
  async forTask(taskKey:string):Promise<ChromeSingleWindowSurface> {
    if(!this.ownsContext)throw new Error("A task cannot allocate another task's browser tab");
    if(!/^[a-f0-9]{64}$/.test(taskKey))throw new Error("Agent Chat task key is invalid");
    const existing=this.taskSurfaces.get(taskKey);
    if(existing)return existing;
    if(this.taskSurfaces.size>=ChromeSingleWindowSurface.MAX_TASK_TABS)
      throw new Error("Agent Chat task tab capacity reached");
    // A page-created event is not tagged with the requesting task. Serialize
    // task allocations to prevent two concurrent calls claiming one tab.
    const pending=this.taskTabCreationTail.then(async()=>{
      await this.page();
      const page=await this.newTab();
      this.delegatedPages.add(page);
      const child=new ChromeSingleWindowSurface(
        this.context,page,false,new Set([page]),this.delegatedPages,this.closed,this.tabCreationGate,
      );
      try {
        await child.navigate(CHATGPT_HOME);
        return child;
      } catch(error) {
        this.delegatedPages.delete(page);
        await page.close().catch(()=>{});
        throw error;
      }
    });
    this.taskTabCreationTail=pending.then(()=>{},()=>{});
    this.taskSurfaces.set(taskKey,pending);
    try {return await pending;}
    catch(error) {
      if(this.taskSurfaces.get(taskKey)===pending)this.taskSurfaces.delete(taskKey);
      throw error;
    }
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
      return surface;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  async page(): Promise<Page> {
    if(this.contextClosed||this.selectedPage.isClosed()||!this.context.pages().includes(this.selectedPage)
      ||(this.ownedPages&&!this.ownedPages.has(this.selectedPage))
      ||(this.ownsContext&&this.delegatedPages.has(this.selectedPage)))
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
    const allMatches=this.context.pages().filter(page=>!page.isClosed()
      &&ChromeSingleWindowSurface.conversationKey(page.url())===key);
    const matches=allMatches.filter(page=>this.ownsContext
      ? !this.delegatedPages.has(page)
      : this.ownedPages?.has(page));
    if(matches.length!==allMatches.length)
      throw new BrowserCompanionError("ChatGPT conversation belongs to another Agent Chat tab","external_interference");
    if(matches.length>1)throw new BrowserCompanionError("Multiple tabs show the same ChatGPT conversation; select a unique target","external_interference");
    if(matches.length===1){this.selectedPage=matches[0]!;return this.page();}
    // A handoff or goal retry during the global load cooldown used to open
    // about:blank and immediately close it. Reject before creating a tab.
    assertConversationLoadAvailableBeforeTab(this.selectedPage,url);
    const previous=this.selectedPage;
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
    if(this.ownsContext)await this.context.close();
    else {
      await Promise.all([...(this.ownedPages??[])].map(page=>page.close().catch(()=>{})));
      for(const page of this.ownedPages??[])this.delegatedByParent?.delete(page);
    }
  }
}
