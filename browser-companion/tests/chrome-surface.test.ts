import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { chromium, type BrowserContext, type Page } from "patchright";
import { readChatGptAccount } from "../src/account";
import { ChromeSingleWindowSurface } from "../src/chrome-surface";
import { privateChromeExecutable } from "../src/chrome-executable";
import { backgroundChromeArgs } from "../src/background-chrome";
import { activeComposer, composerText, insertExactPrompt } from "../src/composer";
import { responseDomSnapshot, type ChatGptResponseDomCache } from "../src/response-observer";
import { readTurnDomState } from "../src/turn-binding";
import {withConversationCooldownBypass} from "../src/navigation";

const fakeExecutablePath = join(tmpdir(), "managed-chrome");

class FakePage extends EventEmitter {
  currentUrl="about:blank";
  url=()=>this.currentUrl;
  owner:FakeContext|undefined;
  context=()=>this.owner as unknown as BrowserContext;
  isClosed = () => this.closed;
  closed = false;
  navigations: string[] = [];
  revealed = false;
  navigationError: Error | undefined;
  async goto(url: string) {
    if (this.navigationError) throw this.navigationError;
    this.navigations.push(url);
    this.currentUrl=url;
  }
  async waitForLoadState() {}
  async evaluate() {}
  async bringToFront() { this.revealed = true; }
  async close() { this.closed = true; this.emit("close"); }
}

class FakeContext extends EventEmitter {
  closed = false;
  windowState = "normal";
  createdTargets: unknown[] = [];
  initScripts: unknown[] = [];
  async addInitScript(script: unknown) { this.initScripts.push(script); }
  constructor(readonly tabs = [new FakePage()]) { super();for(const page of tabs)page.owner=this; }
  pages() { return this.tabs.filter(page => !page.isClosed()) as unknown as Page[]; }
  async newPage() {
    const page = new FakePage();
    page.owner=this;
    this.tabs.push(page);
    this.emit("page", page);
    return page as unknown as Page;
  }
  browser() {
    return { newBrowserCDPSession:async () => ({
      send:async (_method: string, params: unknown) => {
        this.createdTargets.push(params);
        const page = await this.newPage();
      },
      detach:async () => {},
    }) };
  }
  waitForEvent(event: string) {
    return new Promise<Page>(resolve => this.once(event, resolve));
  }
  async newCDPSession() {
    return {
      send:async (method: string) => {
        if (method === "Browser.setWindowBounds") this.windowState = "normal";
        return { windowId:1, bounds:{ windowState:this.windowState } };
      },
      detach:async () => {},
    };
  }
  async close() {
    this.closed = true;
    for (const page of this.tabs) await page.close();
    this.emit("close");
  }
}

let profilePath: string | undefined;
let context: FakeContext | BrowserContext | undefined;
let launchSpy: ReturnType<typeof spyOn<typeof chromium, "launchPersistentContext">> | undefined;

afterEach(async () => {
  launchSpy?.mockRestore();
  launchSpy = undefined;
  await context?.close();
  context = undefined;
  if (profilePath) await rm(profilePath, { recursive:true, force:true });
  profilePath = undefined;
});

async function createSurface(tabs?: FakePage[]) {
  profilePath = await mkdtemp(join(tmpdir(), "browser-chrome-surface-"));
  const fake = new FakeContext(tabs);
  context = fake;
  launchSpy = spyOn(chromium, "launchPersistentContext")
    .mockResolvedValue(fake as unknown as BrowserContext);
  return { surface:await ChromeSingleWindowSurface.create({ profilePath, executablePath:fakeExecutablePath }), fake };
}

const openGoal=(surface:ChromeSingleWindowSurface,url:string)=>
  withConversationCooldownBypass(true,()=>surface.selectConversation(url));

test("the browser uses a dedicated profile and preserves restored tabs", async () => {
  const shared = new FakePage();
  const restored = new FakePage();
  const { surface } = await createSurface([shared, restored]);
  expect(launchSpy).toHaveBeenCalledWith(profilePath, {
    channel:"chrome", executablePath:fakeExecutablePath, headless:false, viewport:null,
    ignoreDefaultArgs:true, args:await backgroundChromeArgs(profilePath!),
  });
  expect(restored.closed).toBeFalse();
  expect(await surface.page()).toBe(shared as unknown as Page);
  expect(shared.navigations).toEqual(["https://chatgpt.com/"]);
  await surface.reveal();
  expect(shared.revealed).toBeTrue();
});

test("startup creates a background page and only an explicit reveal restores focus", async () => {
  const { surface, fake } = await createSurface([]);
  expect(fake.createdTargets).toEqual([{ url:"about:blank", newWindow:true, background:true }]);
  expect(fake.tabs[0]!.revealed).toBeFalse();
  await surface.beginAction();
  await surface.endAction();
  expect(fake.tabs[0]!.revealed).toBeFalse();
  expect(fake.windowState).toBe("normal");
  fake.windowState = "minimized";
  await surface.reveal();
  expect(fake.windowState).toBe("normal");
  expect(fake.tabs[0]!.revealed).toBeTrue();
});

test("startup preserves a restored ChatGPT conversation without loading home",async()=>{
  const shared=new FakePage();shared.currentUrl='https://chatgpt.com/c/restored';
  const {surface,fake}=await createSurface([shared]);
  expect(shared.navigations).toEqual([]);
  expect(shared.closed).toBeFalse();
  expect(fake.tabs).toHaveLength(2);
  expect((await surface.utilityPage()).url()).toBe('https://chatgpt.com/');
  expect(await surface.selectConversation('https://chatgpt.com/c/restored')).toBe(shared as unknown as Page);
});

test("background launch retains Patchright's transport and private profile without a startup URL", async () => {
  const args = await backgroundChromeArgs(fakeExecutablePath);
  expect(args).toContain(`--user-data-dir=${fakeExecutablePath}`);
  expect(args).toContain("--remote-debugging-pipe");
  expect(args).toContain("--no-startup-window");
  expect(args).not.toContain("about:blank");
  expect(args).not.toContain("--headless");
});

test("other tabs remain untouched and closing the selected tab fails closed", async () => {
  const { surface, fake } = await createSurface();
  const extra = await fake.newPage();
  expect(await surface.page()).toBe(fake.tabs[0] as unknown as Page);
  await extra.close();
  expect(await surface.page()).toBeDefined();
  await surface.close();
  await surface.closed;
  await expect(surface.page()).rejects.toMatchObject({ code:"external_interference" });
});

test("each conversation has a persistent tab and visiting another does not navigate the first", async()=>{
  const {surface,fake}=await createSurface();
  const utility=await surface.utilityPage();
  const a=await openGoal(surface,'https://chatgpt.com/c/goal-a');
  expect(a.url()).toBe('https://chatgpt.com/c/goal-a');
  const b=await openGoal(surface,'https://chatgpt.com/c/goal-b');
  expect(b).not.toBe(a);
  expect(fake.tabs).toHaveLength(3);
  expect((a as unknown as FakePage).navigations).toEqual(['https://chatgpt.com/c/goal-a']);
  expect((b as unknown as FakePage).navigations).toEqual(['https://chatgpt.com/c/goal-b']);
  expect(await openGoal(surface,'https://chatgpt.com/c/goal-a')).toBe(a);
  expect((a as unknown as FakePage).navigations).toHaveLength(1);
  expect((await surface.utilityPage())).toBe(utility);
  expect(utility.url()).toBe('https://chatgpt.com/');
  expect(await surface.selectUtilityPage()).toBe(utility);
  expect(await surface.page()).toBe(utility);
  expect((b as unknown as FakePage).closed).toBeFalse();
});

test("new-chat preparation reuses only its own draft tab, never another goal",async()=>{
  const {surface,fake}=await createSurface();
  const goal=await openGoal(surface,'https://chatgpt.com/c/revenue');
  const draft=await surface.newChatPage();
  expect(draft).not.toBe(goal);
  expect(await surface.newChatPage()).toBe(draft);
  await surface.navigate('https://chatgpt.com/');
  expect(await surface.newChatPage()).toBe(draft);
  (draft as unknown as FakePage).currentUrl='https://chatgpt.com/c/new-goal';
  const next=await surface.newChatPage();
  expect(next).not.toBe(draft);
  expect(next).not.toBe(goal);
  expect(fake.tabs).toHaveLength(4);
  expect(goal.url()).toBe('https://chatgpt.com/c/revenue');
  expect(draft.url()).toBe('https://chatgpt.com/c/new-goal');
});

test("duplicate restored tabs for the same conversation refuse ambiguous ownership",async()=>{
  const {surface,fake}=await createSurface();
  const goal=await openGoal(surface,'https://chatgpt.com/c/goal-a');
  const duplicate=await fake.newPage();
  (duplicate as unknown as FakePage).currentUrl='https://chatgpt.com/c/goal-a';
  await expect(openGoal(surface,'https://chatgpt.com/c/goal-a')).rejects.toMatchObject({code:'external_interference'});
  expect((goal as unknown as FakePage).closed).toBeFalse();
  expect((duplicate as unknown as FakePage).closed).toBeFalse();
});

test("several restored goal tabs survive browser restart and route without loading",async()=>{
  const a=new FakePage();a.currentUrl='https://chatgpt.com/c/a';
  const b=new FakePage();b.currentUrl='https://chatgpt.com/c/b';
  const {surface,fake}=await createSurface([a,b]);
  expect(a.closed).toBeFalse();
  expect(b.closed).toBeFalse();
  expect(fake.tabs).toHaveLength(3);
  expect(await surface.selectConversation('https://chatgpt.com/c/a')).toBe(a as unknown as Page);
  expect(await surface.selectConversation('https://chatgpt.com/c/b')).toBe(b as unknown as Page);
  expect(a.navigations).toHaveLength(0);
  expect(b.navigations).toHaveLength(0);
});

test("Chrome actions keep exclusive ownership and reject unsafe or aborted navigation", async () => {
  const { surface, fake } = await createSurface();
  await surface.beginAction();
  await expect(surface.beginAction()).rejects.toThrow("already owns an action");
  await surface.endAction();
  await surface.beginAction();
  await surface.endAction();
  await expect(surface.navigate("http://chatgpt.com/")).rejects.toThrow("requires HTTPS");
  await expect(surface.navigate("https://chatgpt.com/", AbortSignal.abort())).rejects.toThrow("aborted");
  expect(fake.tabs[0]!.navigations).toHaveLength(1);
});

test("startup closes Chrome when initial navigation fails", async () => {
  const page = new FakePage();
  page.navigationError = new Error("navigation failed");
  await expect(createSurface([page])).rejects.toThrow("navigation failed");
  expect(page.closed).toBeTrue();
});

test.skipIf(process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME !== "1")(
  "real Chrome preserves the DOM observer cache and composer in Patchright's default isolated context",
  async () => {
    profilePath = await mkdtemp(join(tmpdir(), "browser-chrome-integration-"));
    const launch = chromium.launchPersistentContext.bind(chromium);
    launchSpy = spyOn(chromium, "launchPersistentContext").mockImplementation(async (profile, options) => {
      const real = await launch(profile, options);
      context = real;
      await real.route("https://chatgpt.com/**", async route => {
        if (new URL(route.request().url()).pathname === "/api/auth/session") {
          await route.fulfill({ json:{ user:{ id:"fixture-user" }, account:{ id:"fixture-account", planType:"plus", structure:"personal" } } });
        } else {
          await route.fulfill({ contentType:"text/html", body:`<!doctype html>
            <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>
            <section data-turn-id-container="assistant-one"><article data-turn-id="assistant-one" data-testid="conversation-turn-1">
              <div data-message-author-role="assistant"><div class="markdown"><p>Fixture answer</p></div></div>
              <button data-testid="copy-turn-action-button">Copy</button>
            </article></section>` });
        }
      });
      return real;
    });
    const executablePath = await privateChromeExecutable(join(import.meta.dirname, "../.browsers", `${process.platform}-${process.arch}`));
    const surface = await ChromeSingleWindowSurface.create({ profilePath, executablePath });
    try {
      const page = await surface.page();
      expect(page.viewportSize()).toBeNull();
      const composer = await activeComposer(page);
      const prompt = "Exact  fixture prompt";
      await insertExactPrompt(composer, prompt);
      expect(await composerText(composer)).toBe(prompt);
      expect((await readChatGptAccount(page)).planType).toBe("plus");
      expect((await readTurnDomState(page)).responseIdentities).toEqual(["assistant-one"]);
      const turn = page.locator('[data-turn-id="assistant-one"]');
      const cache: ChatGptResponseDomCache = {};
      const first = await responseDomSnapshot(turn, cache);
      expect(first.visibleText).toContain("Fixture answer");
      expect(first.completionActionVisible).toBeTrue();
      expect(await responseDomSnapshot(turn, cache)).toEqual(first);
      expect(cache.cacheHits).toBe(1);
      await turn.locator(".markdown p").evaluate(element => { element.textContent = "Updated answer"; });
      expect((await responseDomSnapshot(turn, cache)).visibleText).toContain("Updated answer");
      expect(cache.fullScans).toBe(2);
      await page.close();
      const closed = await Promise.race([surface.closed.then(()=>true),Bun.sleep(2_000).then(()=>false)]);
      expect(closed).toBeTrue();
    } finally {
      await surface.close();
    }
  },
  60_000,
);


test("closing the last Chrome page releases the launcher even if the browser context stays alive",async()=>{
  const {surface,fake}=await createSurface();
  await fake.tabs[0]!.close();await surface.closed;
  expect(fake.closed).toBeFalse();
  await expect(surface.page()).rejects.toMatchObject({code:"external_interference"});
});

test("closing the shared page preserves other open pages until the last window is closed",async()=>{
  const {surface,fake}=await createSurface();const other=await fake.newPage();let stopped=false;
  void surface.closed.then(()=>{stopped=true;});
  await fake.tabs[0]!.close();await Bun.sleep(0);expect(stopped).toBeFalse();
  expect((other as unknown as FakePage).closed).toBeFalse();
  await other.close();await surface.closed;expect(stopped).toBeTrue();
});
