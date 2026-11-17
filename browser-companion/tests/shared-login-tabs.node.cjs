// Small Node-only source smoke test for machines without Bun. It uses the
// repository's installed TypeScript compiler and a fake Chrome transport.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {readFileSync} = require("node:fs");
const {mkdtemp,rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const ts = require("typescript");

class FakePage extends EventEmitter {
  constructor(owner) {
    super();
    this.owner=owner;
    this.currentUrl="about:blank";
    this.closed=false;
  }
  context(){return this.owner;}
  url(){return this.currentUrl;}
  isClosed(){return this.closed;}
  async goto(url){this.currentUrl=url;}
  async waitForLoadState(){}
  async evaluate(){}
  async bringToFront(){}
  async close(){this.closed=true;this.emit("close");}
}

class FakeContext extends EventEmitter {
  constructor(){
    super();
    this.tabs=[new FakePage(this)];
    this.closed=false;
  }
  async addInitScript(){}
  pages(){return this.tabs.filter(page=>!page.isClosed());}
  async waitForEvent(event){return new Promise(resolve=>this.once(event,resolve));}
  browser(){
    return {newBrowserCDPSession:async()=>({
      send:async method=>{
        assert.equal(method,"Target.createTarget");
        const page=new FakePage(this);
        this.tabs.push(page);
        this.emit("page",page);
      },
      detach:async()=>{},
    })};
  }
  async close(){
    if(this.closed)return;
    this.closed=true;
    for(const page of this.tabs)await page.close();
    this.emit("close");
  }
}

function loadRealSurface(fake){
  const source=readFileSync(join(__dirname,"../src/chrome-surface.ts"),"utf8");
  const javascript=ts.transpileModule(source,{compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
  }}).outputText;
  class BrowserCompanionError extends Error {
    constructor(message,code){super(message);this.code=code;}
  }
  const mocks={
    patchright:{chromium:{launchPersistentContext:async()=>fake}},
    "./chatgpt-driver":{},
    "./errors":{BrowserCompanionError},
    "./background-chrome":{backgroundChromeArgs:async()=>[]},
    "./request-block-list":{
      prepareRequestBlockList:async()=>[],
      requestBlockListArgs:async args=>args,
      verifyRequestBlockList:async()=>{},
    },
    "./navigation":{
      assertConversationLoadAvailableBeforeTab:()=>{},
      isChatGptPage:url=>url.startsWith("https://chatgpt.com/"),
      navigatePage:async(page,url)=>page.goto(url),
      observeConversationLoadResponses:()=>{},
    },
    "./chat-mode":{installChatModeCompatibility:()=>{}},
    "./protocol":{
      canonicalChatGptConversationUrl:url=>url,
      validateChatGptConversationUrl:url=>{
        if(!url.startsWith("https://chatgpt.com/c/"))throw Error("invalid URL");
      },
    },
  };
  const exports={};
  new Function("require","exports","module",javascript)(
    name=>mocks[name]??require(name),exports,{exports},
  );
  return exports.ChromeSingleWindowSurface;
}

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),"codexify-shared-login-test-"));
  const context=new FakeContext();
  const Surface=loadRealSurface(context);
  const surface=await Surface.create({profilePath:dir,executablePath:join(dir,"mock-chrome")});
  t.after(async()=>{await surface.close();await rm(dir,{recursive:true,force:true});});
  return {surface,context};
}

test("eight task tabs share one context and keep stable identities",async t=>{
  const {surface,context}=await setup(t);
  const keys=Array.from({length:8},(_,i)=>(i+1).toString(16).padStart(64,"0"));
  const lanes=await Promise.all(keys.map(key=>surface.forTask(key)));
  const pages=await Promise.all(lanes.map(lane=>lane.page()));
  assert.equal(new Set(pages).size,8);
  assert.ok(pages.every(page=>page.context()===context));
  assert.equal(context.pages().length,9);
  assert.equal(await surface.forTask(keys[0]),lanes[0]);
});

test("one task cannot take over another task's conversation or close its page",async t=>{
  const {surface,context}=await setup(t);
  const first=await surface.forTask("a".repeat(64));
  const second=await surface.forTask("b".repeat(64));
  await first.selectConversation("https://chatgpt.com/c/a");
  await assert.rejects(second.selectConversation("https://chatgpt.com/c/a"),/another Agent Chat tab/);
  await assert.rejects(surface.selectConversation("https://chatgpt.com/c/a"),/another Agent Chat tab/);
  await second.selectConversation("https://chatgpt.com/c/b");
  await first.close();
  await first.closed;
  assert.equal(context.closed,false);
  assert.equal((await second.page()).url(),"https://chatgpt.com/c/b");
});

test("invalid task keys fail closed and allocation limit covers eight",async t=>{
  const {surface}=await setup(t);
  await assert.rejects(surface.forTask("wrong"),/task key is invalid/);
  await Promise.all(Array.from({length:16},(_,i)=>surface.forTask((i+1).toString(16).padStart(64,"0"))));
  await assert.rejects(surface.forTask("f".repeat(64)),/capacity reached/);
});
