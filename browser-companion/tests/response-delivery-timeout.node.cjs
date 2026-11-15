// Standalone Node fixture so this recovery can be verified even when Bun is absent.
// No personal Chrome profile or live ChatGPT request is used.
const {before,after,test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {chromium}=require("patchright");
const jiti=require("jiti")(__filename);
const {deliveryTimeoutText,previousResponseDeliveryTimedOut,throwIfSessionAttention}=jiti("../src/browser-session.ts");
const url="https://chatgpt.com/c/timeout-fixture";
let context,page,profile;

test("Slovene and English delivery notices are narrowly recognized",()=>{
  assert(deliveryTimeoutText.test("\u010cas za dostavo sporo\u010dila se je iztekel. Poskusite znova."));
  assert(deliveryTimeoutText.test("Message delivery timed out. Please try again."));
  assert(!deliveryTimeoutText.test("Unexpected API timeout before sending your message."));
  assert(!deliveryTimeoutText.test("Cas za dostavo sporocila se je iztekel."));
});

before(async()=>{
  profile=fs.mkdtempSync(path.join(os.tmpdir(),"codexify-timeout-fixture-"));
  const candidates=[
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const executablePath=candidates.find(candidate=>fs.existsSync(candidate));
  context=await chromium.launchPersistentContext(profile,{headless:true,channel:"chrome",...(executablePath?{executablePath}:{})});
  page=context.pages()[0]??await context.newPage();
  await context.route("https://chatgpt.com/**",route=>route.fulfill({
    contentType:"text/html",
    body:"<!doctype html><main><form><div id='prompt-textarea' contenteditable='true'></div></form></main>",
  }));
  await page.goto(url);
});

after(async()=>{
  await context?.close();
  if(profile)fs.rmSync(profile,{recursive:true,force:true});
});

test("Slovene app-owned delivery timeout permits recovery without clicking Retry",async()=>{
  await page.setContent(`<main><form><div id="prompt-textarea" contenteditable="true"></div></form>
    <article data-message-author-role="user">Prior accepted question</article>
    <div role="alert">\u010cas za dostavo sporo\u010dila se je iztekel. Poskusite znova.
      <button data-testid="regenerate-thread-error-button" onclick="document.body.dataset.retried='true'">Poskusi znova</button>
    </div></main>`);
  assert.equal(await previousResponseDeliveryTimedOut(page),true);
  await throwIfSessionAttention(page);
  assert.equal(await page.locator("body").getAttribute("data-retried"),null);
});

test("localized timeout with app retry control but no alert role recovers without clicking",async()=>{
  await page.setContent(`<main><form><div id="prompt-textarea" contenteditable="true"></div></form>
    <div class="rounded border border-red">
      <p>\u010cas za dostavo sporo\u010dila se je iztekel. Poskusite znova.</p>
      <button data-testid="regenerate-thread-error-button" onclick="document.body.dataset.retried='true'">Poskusi znova</button>
    </div></main>`);
  assert.equal(await previousResponseDeliveryTimedOut(page),true);
  await throwIfSessionAttention(page);
  assert.equal(await page.locator("body").getAttribute("data-retried"),null);
});

test("a quoted timeout cannot spoof app-owned timeout recovery",async()=>{
  await page.setContent(`<main><form><div id="prompt-textarea" contenteditable="true"></div></form>
    <article data-message-author-role="user"><div role="alert">\u010cas za dostavo sporo\u010dila se je iztekel.</div></article>
    <button data-testid="regenerate-thread-error-button">Try again</button></main>`);
  assert.equal(await previousResponseDeliveryTimedOut(page),false);
  await assert.rejects(()=>throwIfSessionAttention(page),error=>error.code==="failed");
});

test("unrelated terminal error still blocks continuation",async()=>{
  await page.setContent(`<main><form><div id="prompt-textarea" contenteditable="true"></div></form>
    <div role="alert">Something went wrong.</div><button data-testid="regenerate-thread-error-button">Try again</button></main>`);
  assert.equal(await previousResponseDeliveryTimedOut(page),false);
  await assert.rejects(()=>throwIfSessionAttention(page),error=>error.code==="failed");
});
