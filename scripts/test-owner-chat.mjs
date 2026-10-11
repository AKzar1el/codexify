import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { chatHtml } from "./chat-widget-source.mjs";

const { chromium, webkit } = createRequire(import.meta.url)("playwright");
const META = "io.github.devnoname120/codexify/markdown-chat";
const section = (text, opening, closing) => text.split(opening)[1].split(closing)[0];
const style = section(chatHtml, "<style>", "</style>")
  .replace(':root:not([data-theme="light"])', ':host(:not([data-theme="light"]))')
  .replace(':root[data-theme="dark"]', ':host([data-theme="dark"])')
  .replaceAll(":root", ":host")
  .replace("body {", ":host { display:block;");
const widgetBody = section(chatHtml, "<body>", "<script>");
const widgetScript = section(chatHtml, "<script>", "</script>");
const ownerHtml = readFileSync(new URL("../src/owner_chat.html", import.meta.url), "utf8")
  .replace("<!-- CHAT_TEMPLATE -->", `<template id="chat-template"><style>${style}\n#chat { max-width:none; height:100%; border:0; border-radius:0; display:flex; flex-direction:column; } #panel { display:flex; flex:1; min-height:0; flex-direction:column; } #panel[hidden] { display:none; } #messages { flex:1; max-height:none; min-height:0; }\n</style>${widgetBody}</template>`)
  .replace("/* CHAT_SCRIPT */", widgetScript);

for (const [engineName, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
test(`${engineName}: standalone owner view restores its URL selection`, { timeout:30000 }, async () => {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    const copied = [];
    const markdownRequests = [];
    await page.exposeFunction("recordClipboard", text => copied.push(text));
    await page.addInitScript(() => {
      window.__writeTestClipboard = async text => {
        await window.recordClipboard(text);
        window.__lastCopied = text;
      };
      Object.defineProperty(navigator, "clipboard", {
        configurable:true,
        value:{ writeText:text => window.__writeTestClipboard(text) }
      });
    });
    page.on("pageerror", error => errors.push(error.message));
    const now = Date.now();
    const rawSource = "**Rendered**  \n\n```js\nconst x = 1;\n```";
    const wholeTranscript = `## Agent\n\nOlder server-only entry\n\n## Agent\n\n${rawSource}`;
    const chats = [
      { id:"a".repeat(64), title:"Fix tests", workspace:"project-a", lastEntryEnd:200, lastEntryAtMs:now, lastAgentCallAtMs:now, totalToolCalls:3 },
      { id:"b".repeat(64), title:"Review files", workspace:"project-b", lastEntryEnd:100, lastEntryAtMs:now - 60000, lastAgentCallAtMs:now - 240000, totalToolCalls:1 },
      { id:"c".repeat(64), title:"Old task", workspace:"project-c", lastEntryEnd:75, lastEntryAtMs:now - 120000, lastAgentCallAtMs:null, totalToolCalls:0 }
    ];
    const messages = new Map(chats.map(chat => [chat.id, []]));
    messages.get(chats[0].id).push({ id:"raw-one", role:"agent", markdown:rawSource, start:1, end:100, created_at_ms:now, tool_call_count:3 });
    const seenRequests = [];
    let failPolling = false;
    await page.route("http://127.0.0.1:43210/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/") return route.fulfill({ contentType:"text/html", body:ownerHtml, headers:{
        "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      } });
      seenRequests.push(request.headers().authorization);
      if (failPolling) return route.fulfill({ status:503, body:"Preview connection unavailable" });
      if (url.pathname === "/api/chats") return route.fulfill({ json:{ chats, serverTimeMs:Date.now() } });
      const id = url.pathname.split("/")[3];
      if (url.pathname.endsWith("/automation")) return route.fulfill({ json:{ enabled:false, serverTimeMs:Date.now() } });
      if (url.pathname.endsWith("/markdown")) {
        markdownRequests.push(url.pathname);
        return route.fulfill({ contentType:"text/markdown; charset=utf-8", body:wholeTranscript });
      }
      if (url.pathname.endsWith("/send")) {
        const body = request.postDataJSON();
        const end = chats.find(chat => chat.id === id).lastEntryEnd += 100;
        chats.find(chat => chat.id === id).agentWaitingUntilMs = null;
        const tool_call_count = chats.find(chat => chat.id === id).totalToolCalls;
        messages.get(id).push({ id:body.request_id, role:"user", markdown:body.message, start:end - 100, end, created_at_ms:Date.now(), tool_call_count });
        return route.fulfill({ json:{ _meta:{ [META]:{ sent:{ id:body.request_id, end, created_at_ms:Date.now(), tool_call_count } } } } });
      }
      if (url.pathname.startsWith("/api/chats/")) {
        const rows = messages.get(id);
        return route.fulfill({ json:{ _meta:{ [META]:{
          chat_file:`/private/${id}/CHAT.md`, revision:String(chats.find(chat => chat.id === id).lastEntryEnd),
          delivered_through:0, read_through:0, last_agent_call_at_ms:chats.find(chat => chat.id === id).lastAgentCallAtMs,
          agent_waiting_until_ms:chats.find(chat => chat.id === id).agentWaitingUntilMs ?? null,
          total_tool_calls:chats.find(chat => chat.id === id).totalToolCalls, server_time_ms:Date.now(),
          messages:rows, has_more:false, before:rows[0]?.start ?? null, unchanged:false
        } } } });
      }
      return route.fulfill({ status:404 });
    });
    await page.goto("http://127.0.0.1:43210/#test-token");
    await page.getByRole("button", { name:/Fix tests/ }).waitFor();
    assert.equal(new URL(page.url()).hash, "#test-token", "the access token must remain in the address bar");
    assert.deepEqual(await page.locator(".conversation-title").allTextContents(), ["Fix tests", "Review files", "Old task"]);
    assert.deepEqual(await page.locator(".presence").evaluateAll(nodes => nodes.map(node => [...node.classList].at(-1))), ["online", "away", "offline"]);
    assert.equal(await page.locator(".unread:not([hidden])").count(), 3);
    for (const size of await page.locator(".presence").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))) assert(size <= 14);
    assert(!((await page.locator(".conversation-detail").allTextContents()).some(text => text.includes("No messages"))));
    await page.getByRole("button", { name:/Fix tests/ }).click();
    assert.equal(await page.locator("#automation-panel:visible").count(), 0);
    chats[0].agentWaitingUntilMs = Date.now() + 120000;
    await page.locator(".conversation:nth-of-type(1) .presence.waiting").waitFor();
    await page.locator('#chat-host #presence[data-state="waiting"]').waitFor();
    assert.equal(await page.locator(".conversation:nth-of-type(1) .presence circle").count(), 3);
    assert.equal(await page.locator(".conversation:nth-of-type(1) .presence path").getAttribute("fill"), "currentColor");
    assert.equal(new URL(page.url()).searchParams.get("chat"), chats[0].id);
    assert.equal(new URL(page.url()).hash, "#test-token");
    const chatHost = page.locator("#chat-host");
    await chatHost.getByRole("button", { name:"Copy message Markdown", exact:true }).first().click();
    await page.waitForFunction(expected => window.__lastCopied === expected, rawSource);
    assert.equal(copied.at(-1), rawSource);
    await chatHost.getByRole("button", { name:"Copy whole chat as Markdown", exact:true }).click();
    await page.waitForFunction(expected => window.__lastCopied === expected, wholeTranscript);
    assert.equal(markdownRequests.at(-1), `/api/chats/${chats[0].id}/markdown`);
    assert.equal(copied.at(-1), wholeTranscript);
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); };
    });
    await chatHost.getByRole("button", { name:"Copy message Markdown", exact:true }).first().click();
    await chatHost.getByText("Could not copy message Markdown.", { exact:true }).waitFor();
    await page.evaluate(() => {
      navigator.clipboard.writeText = text => window.__writeTestClipboard(text);
    });
    const chat = page.locator("#chat-host .chat-shell #draft");
    await chat.fill("Please run the test suite");
    await page.locator("#chat-host #send:enabled").waitFor();
    await chat.press("Enter");
    await page.locator("#chat-host").getByText("Please run the test suite").waitFor();
    await page.locator('#chat-host #presence[data-state="online"]').waitFor();
    await page.locator(".conversation:nth-of-type(1) .presence.online").waitFor();
    if (process.env.CODEXIFY_WORKSPACE_SCREENSHOTS) {
      mkdirSync(process.env.CODEXIFY_WORKSPACE_SCREENSHOTS, { recursive:true });
      await page.screenshot({ path:`${process.env.CODEXIFY_WORKSPACE_SCREENSHOTS}/${engineName.toLowerCase()}-sidebar.png`, fullPage:true });
    }
    await page.getByRole("button", { name:/Review files/ }).click();
    assert.equal(new URL(page.url()).searchParams.get("chat"), chats[1].id);
    await page.locator("#chat-host").getByText("Please run the test suite").waitFor({ state:"hidden" });
    await page.goBack();
    await page.locator("#chat-host").getByText("Please run the test suite").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("chat"), chats[0].id);
    await page.goBack();
    await page.locator("#placeholder").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("chat"), null);
    await page.goForward();
    await page.locator("#chat-host").getByText("Please run the test suite").waitFor();
    await page.goForward();
    await page.locator("#chat-host").getByText("Please run the test suite").waitFor({ state:"hidden" });
    await page.reload();
    await page.locator('.conversation[aria-current="true"] .conversation-title').getByText("Review files").waitFor();
    await page.locator("#chat-host #draft").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("chat"), chats[1].id);
    assert.equal(new URL(page.url()).hash, "#test-token");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`http://127.0.0.1:43210/?chat=${chats[0].id}#test-token`);
    await page.locator("#chat-host").getByText("Please run the test suite").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("chat"), chats[0].id);
    assert.equal(new URL(page.url()).hash, "#test-token");
    assert(seenRequests.length > 0 && seenRequests.every(value => value === "Bearer test-token"));
    const clock = Date.now();
    await page.clock.install({ time:clock });
    chats[1].agentWaitingUntilMs = clock + 20000;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator(".conversation:nth-of-type(2) .presence.waiting").waitFor();
    failPolling = true;
    await page.clock.fastForward(20000);
    await page.locator(".conversation:nth-of-type(2) .presence.away").waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test(`${engineName}: project grouping, transcript search, and persistent names`, { timeout:30000 }, async () => {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const now = Date.now();
    const chats = [
      { id:"1".repeat(64), title:"Newest alpha", workspace:"same-name", projectId:"alpha", projectPath:"/projects/alpha/same-name", lastEntryAtMs:now },
      { id:"2".repeat(64), title:"Middle beta", workspace:"same-name", projectId:"beta", projectPath:"/projects/beta/same-name", lastEntryAtMs:now - 1000 },
      { id:"3".repeat(64), title:"Older alpha", workspace:"same-name", projectId:"alpha", projectPath:"/projects/alpha/same-name", lastEntryAtMs:now - 2000 },
      { id:"4".repeat(64), title:"Oldest beta", workspace:"same-name", projectId:"beta", projectPath:"/projects/beta/same-name", lastEntryAtMs:now - 3000 }
    ].map(chat => ({ ...chat, customTitle:null, latestTitle:chat.title, lastEntryEnd:100, lastAgentCallAtMs:null, totalToolCalls:0 }));
    let releaseOldSearch = null;
    await page.route("http://127.0.0.1:43212/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/") return route.fulfill({ contentType:"text/html", body:ownerHtml });
      assert.equal(request.headers().authorization, "Bearer test-token");
      if (url.pathname === "/api/chats") {
        const query = url.searchParams.get("q") || "";
        const matchedChatIds = query === "buried text" ? [chats[1].id] : query === "delayed" ? [chats[3].id] : chats.filter(chat => chat.title.toLowerCase().includes(query.toLowerCase())).map(chat => chat.id);
        if (query === "delayed") await new Promise(resolve => { releaseOldSearch = resolve; });
        return route.fulfill({ json:{ chats, matchedChatIds, serverTimeMs:Date.now() } });
      }
      const chat = chats.find(chat => chat.id === url.pathname.split("/")[3]);
      if (url.pathname.endsWith("/title")) {
        chat.customTitle = request.postDataJSON().title.trim() || null;
        chat.title = chat.customTitle || chat.latestTitle;
        return route.fulfill({ json:{ title:chat.title, customTitle:chat.customTitle } });
      }
      if (url.pathname.endsWith("/automation")) return route.fulfill({ json:{ enabled:false } });
      return route.fulfill({ json:{ _meta:{ [META]:{
        chat_file:`/private/${chat.id}/CHAT.md`, revision:"100", delivered_through:0, read_through:0,
        last_agent_call_at_ms:null, agent_waiting_until_ms:null, total_tool_calls:0,
        server_time_ms:Date.now(), messages:[], has_more:false, before:null, unchanged:false
      } } } });
    });
    await page.goto(`http://127.0.0.1:43212/?chat=${chats[0].id}#test-token`);
    await page.locator(".project-heading").first().waitFor();
    assert.deepEqual(await page.locator(".conversation-title").allTextContents(), ["Newest alpha", "Older alpha", "Middle beta", "Oldest beta"]);
    assert.deepEqual(await page.locator(".project-heading").evaluateAll(nodes => nodes.map(node => node.title)), ["/projects/alpha/same-name", "/projects/beta/same-name"]);
    await page.getByRole("button", { name:"Recent", exact:true }).click();
    assert.deepEqual(await page.locator(".conversation-title").allTextContents(), ["Newest alpha", "Middle beta", "Older alpha", "Oldest beta"]);
    await page.reload();
    await page.locator(".conversation-title").first().waitFor();
    assert.equal(await page.locator(".project-heading").count(), 0);
    await page.getByRole("button", { name:"Projects", exact:true }).click();

    const search = page.getByRole("searchbox", { name:"Search chats" });
    await search.fill("buried text");
    await page.getByRole("button", { name:/Middle beta/ }).waitFor();
    assert.deepEqual(await page.locator(".conversation-title").allTextContents(), ["Middle beta"]);
    assert.equal(await page.locator("#chat-host #draft").count(), 1, "filtering must keep the selected conversation open");
    assert.equal(new URL(page.url()).searchParams.get("chat"), chats[0].id);
    await search.fill("delayed");
    for (let attempts = 0; !releaseOldSearch && attempts < 50; attempts++) await page.waitForTimeout(20);
    assert(releaseOldSearch);
    await search.fill("Newest alpha");
    await page.getByRole("button", { name:/Newest alpha/ }).waitFor();
    releaseOldSearch();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.locator(".conversation-title").allTextContents(), ["Newest alpha"]);
    await search.fill("no matching content");
    await page.getByText("No matching chats.", { exact:true }).waitFor();
    await search.fill("");
    await page.getByRole("button", { name:/Newest alpha/ }).waitFor();

    const panel = page.locator("#chat-host");
    await panel.getByRole("button", { name:"Rename chat" }).click();
    await panel.getByLabel("Chat name").fill("Saved release name");
    await panel.getByRole("button", { name:"Save name" }).click();
    await page.getByRole("button", { name:/Saved release name/ }).waitFor();
    chats[0].latestTitle = "Latest agent answer";
    await page.reload();
    await page.getByRole("button", { name:/Saved release name/ }).waitFor();
    await panel.getByRole("button", { name:"Rename chat" }).click();
    assert.equal(await panel.getByLabel("Chat name").inputValue(), "Saved release name");
    await panel.getByLabel("Chat name").fill("");
    await panel.getByRole("button", { name:"Save name" }).click();
    await page.getByRole("button", { name:/Latest agent answer/ }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test(`${engineName}: standalone automation controls drive only authenticated owner APIs`, { timeout:30000 }, async () => {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    const operations = [];
    let holdNextState = false, releaseHeldState, heldStateStarted;
    page.on("pageerror", error => errors.push(error.message));
    const now = Date.now();
    const chat = {
      id:"d".repeat(64), title:"Automate task", workspace:"project-d",
      lastEntryEnd:100, lastEntryAtMs:now, lastAgentCallAtMs:now - 360000,
      agentWaitingUntilMs:null, totalToolCalls:4
    };
    const messages = [];
    const automation = {
      enabled:true,
      ownerGeneration:0,
      pairing:{ status:"unpaired", candidateUrl:null, canonicalUrl:null, generation:0, verifiedAtMs:null, expiresAtMs:null },
      selection:{ model:"gpt-6-astra", effort:"max", catalogRevision:"saved-catalog" },
      goal:null,
      action:{ id:null, kind:null, status:"idle", pairingGeneration:null, goalRevision:null, lastError:null, lastStableAnswer:null, updatedAtMs:null },
      live:{ actionId:"action-live", phase:"generating", status:"Inspecting the workspace", commentary:"Visible commentary", answer:"Partial browser answer", updatedAtMs:now },
      companion:{ status:"idle", authenticated:true, activeActionId:null, detail:null },
      presence:{ lastAgentCallAtMs:chat.lastAgentCallAtMs, agentWaitingUntilMs:null, totalToolCalls:chat.totalToolCalls },
      queue:{ position:2, total:3 },
      serverTimeMs:now
    };
    const meta = payload => ({ _meta:{ [META]:payload } });
    await page.route("http://127.0.0.1:43211/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/") return route.fulfill({ contentType:"text/html", body:ownerHtml, headers:{
        "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      } });
      assert.equal(request.headers().authorization, "Bearer test-token");
      if (url.pathname === "/api/chats") return route.fulfill({ json:{ chats:[chat], serverTimeMs:Date.now() } });
      if (url.pathname === `/api/chats/${chat.id}`) return route.fulfill({ json:meta({
        chat_file:`/private/${chat.id}/CHAT.md`, revision:String(chat.lastEntryEnd),
        delivered_through:0, read_through:0, last_agent_call_at_ms:chat.lastAgentCallAtMs,
        agent_waiting_until_ms:null, total_tool_calls:chat.totalToolCalls, server_time_ms:Date.now(),
        messages, has_more:false, before:null, unchanged:false
      }) });
      if (url.pathname === `/api/chats/${chat.id}/automation` && request.method() === "GET") {
        const snapshot = structuredClone(automation);
        if (holdNextState) {
          holdNextState = false;
          snapshot.live.status = "Stale selection poll received";
          const released = new Promise(resolve => { releaseHeldState = resolve; });
          heldStateStarted(); await released;
        }
        return route.fulfill({ json:snapshot });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/capabilities`) {
        operations.push("capabilities");
        return route.fulfill({ json:{
          companion:automation.companion,
          catalogRevision:"catalog-live",
          models:[
            { id:"gpt-6-astra", label:"GPT-6 Astra", efforts:[{ id:"max", label:"Pro", available:true, reason:null }] },
            { id:"gpt-6-sol", label:"GPT-6 Sol", efforts:[
              { id:"high", label:"High", available:true, reason:null },
              { id:"max", label:"Max", available:false, reason:"Not available for this account" }
            ] },
            { id:"gpt-5.6-sol", label:"GPT-5.6 Sol", efforts:[
              { id:"medium", label:"Medium", available:true, reason:null }
            ] }
          ]
        } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/selection`) {
        const body = request.postDataJSON(); operations.push(["selection", body]);
        automation.selection = { model:body.model, effort:body.effort, catalogRevision:"catalog-live" };
        return route.fulfill({ json:{ selection:automation.selection } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/pair`) {
        const body = request.postDataJSON(); operations.push(["pair", body]);
        automation.pairing = { status:"unverified", candidateUrl:body.url, canonicalUrl:null, generation:1, verifiedAtMs:null, expiresAtMs:now + 60000 };
        automation.action = { id:"pair-action", kind:"pair_verify", status:"queued", pairingGeneration:1, goalRevision:null, lastError:null, lastStableAnswer:null, updatedAtMs:Date.now() };
        return route.fulfill({ json:{ pairing:automation.pairing, action:automation.action } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/unlink`) {
        operations.push(["unlink", request.postDataJSON()]);
        automation.pairing = { status:"unpaired", candidateUrl:null, canonicalUrl:null, generation:2, verifiedAtMs:null, expiresAtMs:null };
        automation.action = { id:null, kind:null, status:"idle", pairingGeneration:null, goalRevision:null, lastError:null, lastStableAnswer:null, updatedAtMs:Date.now() };
        return route.fulfill({ json:{ pairing:automation.pairing } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/login`) {
        operations.push("login"); automation.companion.authenticated = true;
        return route.fulfill({ json:{ companion:automation.companion } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/reveal`) {
        operations.push("reveal"); return route.fulfill({ json:{ opened:true } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/action/cancel`) {
        const body = request.postDataJSON(); operations.push(["cancel", body]);
        if (automation.action.kind === "pair_verify") {
          automation.pairing = { status:"unpaired", candidateUrl:null, canonicalUrl:null, generation:automation.pairing.generation + 1, verifiedAtMs:null, expiresAtMs:null };
          automation.action = { id:null, kind:null, status:"unpaired", pairingGeneration:automation.pairing.generation, goalRevision:null, lastError:null, lastStableAnswer:null, updatedAtMs:Date.now() };
        } else {
          automation.action = { ...automation.action, status:"failed", lastError:"Browser action cancelled before Send", updatedAtMs:Date.now() };
        }
        automation.queue = null;
        return route.fulfill({ json:{ action:automation.action, queue:null } });
      }
      if (url.pathname === `/api/chats/${chat.id}/automation/action/retry`) {
        const body = request.postDataJSON(); operations.push(["retry", body]);
        automation.action = { ...automation.action, id:"retried-action", status:"queued", lastError:null, updatedAtMs:Date.now() };
        automation.queue = { position:1, total:1 };
        return route.fulfill({ json:{ action:automation.action, queue:automation.queue } });
      }
      if (url.pathname === `/api/chats/${chat.id}/send`) {
        const body = request.postDataJSON(); operations.push(["send", body.message]);
        if (body.message.startsWith("/goal set ")) automation.goal = {
          revision:1, markdown:body.message.slice(10), status:"configured", createdAtMs:now,
          updatedAtMs:Date.now(), finishedAtMs:null, summary:null, blockedReason:null
        };
        else if (body.message === "/goal run") automation.goal.status = "active";
        else if (body.message === "/goal stop") automation.goal.status = "configured";
        else if (body.message === "/goal clear") automation.goal = null;
        return route.fulfill({ json:meta({ localCommand:{}, goal:automation.goal, goalCommand:body.message.split(" ")[1], replayed:false }) });
      }
      return route.fulfill({ status:404, body:"Not found" });
    });

    await page.goto(`http://127.0.0.1:43211/?chat=${chat.id}#test-token`);
    const panel = page.locator("#chat-host");
    await panel.locator("#composer-tools").waitFor();
    assert.equal(await panel.locator("#automation-settings").isVisible(), false);
    const model = panel.getByLabel("ChatGPT model");
    const effort = panel.getByLabel("Reasoning effort");
    await panel.locator("#automation-model:enabled").waitFor();
    assert.equal(await model.locator("option:checked").textContent(), "GPT-6 Astra");
    assert.equal(await effort.locator("option:checked").textContent(), "Pro");
    assert.equal(await effort.inputValue(), "max");
    holdNextState = true;
    await new Promise(resolve => { heldStateStarted = resolve; });
    await model.selectOption("gpt-5.6-sol");
    await panel.locator("#automation-model:enabled").waitFor();
    assert.deepEqual(await effort.locator("option").allTextContents(), ["Medium"]);
    await panel.getByRole("button", {name:"Connection settings",exact:true}).click();
    releaseHeldState();
    await panel.getByText("Stale selection poll received", {exact:true}).waitFor();
    assert.equal(await model.inputValue(), "gpt-5.6-sol", "an old poll must not overwrite a successful save");
    assert.equal(await effort.inputValue(), "medium");
    await panel.getByRole("button", {name:"Close connection settings",exact:true}).click();
    await model.selectOption("gpt-6-sol");
    await panel.locator("#automation-model:enabled").waitFor();
    assert.deepEqual(await effort.locator("option").allTextContents(), ["High"]);
    assert.equal(await effort.locator('option[value="max"]').count(), 0);
    assert.equal(await panel.locator("#composer #automation-model").count(), 1);
    assert.equal(await panel.locator("#composer #automation-effort").count(), 1);

    await panel.getByRole("button", { name:"Connection settings", exact:true }).click();
    await panel.getByText("Offline", { exact:true }).waitFor();
    await panel.getByText(/Queue 2 of 3/).waitFor();
    await panel.getByText("Inspecting the workspace", { exact:true }).waitFor();
    await panel.getByText("Partial browser answer", { exact:true }).waitFor();
    assert.equal(await panel.getByRole("button", { name:"Open in ChatGPT" }).isDisabled(), true);
    await panel.getByRole("button", { name:"Refresh models" }).click();
    await panel.getByLabel("ChatGPT conversation URL").fill("https://chatgpt.com/c/owner-automation");
    await panel.getByRole("button", { name:"Pair conversation" }).click();
    await panel.getByText("Pairing verification queued", { exact:true }).waitFor();
    await panel.getByRole("button", { name:"Cancel queued action" }).click();
    await panel.getByText("Not paired", { exact:true }).waitFor();
    await panel.getByRole("button", { name:"Pair conversation" }).click();
    await panel.getByText("Pairing verification queued", { exact:true }).waitFor();
    automation.companion.activeActionId = "busy-action";
    await panel.locator("#automation-capabilities:disabled").waitFor();
    await panel.getByRole("button", { name:"Open in ChatGPT" }).click();
    automation.companion.activeActionId = null;
    await panel.getByRole("button", { name:"Close connection settings" }).click();

    await panel.getByRole("button", { name:"Add goal", exact:true }).click();
    await panel.getByLabel("Goal Markdown").fill("Finish the standalone controls.");
    await panel.getByRole("button", { name:"Set goal", exact:true }).click();
    await panel.locator("#goal-bar").getByText("Finish the standalone controls.", { exact:true }).waitFor();
    await panel.getByRole("button", { name:"Run goal" }).click();
    await panel.getByText("Pursuing goal", { exact:true }).waitFor();
    const goalBox = await panel.locator("#goal-bar").boundingBox();
    const composerBox = await panel.locator("#composer").boundingBox();
    assert(goalBox && composerBox && goalBox.y < composerBox.y && goalBox.y + goalBox.height <= composerBox.y + 12);
    if (process.env.CODEXIFY_WORKSPACE_SCREENSHOTS) {
      mkdirSync(process.env.CODEXIFY_WORKSPACE_SCREENSHOTS, { recursive:true });
      await page.screenshot({ path:`${process.env.CODEXIFY_WORKSPACE_SCREENSHOTS}/${engineName.toLowerCase()}-composer.png`, fullPage:true });
    }
    await panel.getByRole("button", { name:"Pause goal" }).click();
    await panel.getByRole("button", { name:"Clear goal" }).click();
    await panel.locator("#goal-bar").waitFor({ state:"hidden" });
    assert.equal(messages.length, 0, "local goal controls must not enter chat history");

    automation.presence.lastAgentCallAtMs = Date.now();
    await panel.locator("#automation-model:disabled").waitFor();
    assert.equal(await effort.isDisabled(), true);
    await panel.getByText("Model and effort can be changed when the agent is offline.", { exact:true }).waitFor();
    automation.presence.lastAgentCallAtMs = Date.now() - 240000;
    await page.waitForTimeout(1600);
    assert.equal(await model.isDisabled(), true, "away agents must also lock model changes");
    automation.presence.lastAgentCallAtMs = Date.now() - 360000;
    automation.presence.agentWaitingUntilMs = Date.now() + 30000;
    await page.waitForTimeout(1600);
    assert.equal(await model.isDisabled(), true, "waiting agents must also lock model changes");
    automation.presence.agentWaitingUntilMs = null;
    await panel.locator("#automation-model:enabled").waitFor();
    await panel.getByRole("button", { name:"Connection settings", exact:true }).click();
    automation.action = { id:"failed-action", kind:"offline_chat", status:"failed", pairingGeneration:1, goalRevision:null, lastError:"Selector verification failed before Send", lastStableAnswer:null, updatedAtMs:Date.now() };
    automation.queue = null;
    await panel.getByRole("button", { name:"Retry failed action" }).waitFor({ state:"visible" });
    await panel.locator("#automation-retry-action:enabled").waitFor();
    await panel.getByRole("button", { name:"Retry failed action" }).click();
    await panel.locator("#automation-action").getByText("Queued", { exact:true }).waitFor();
    await panel.getByRole("button", { name:"Cancel queued action" }).click();
    await panel.locator("#automation-action").getByText("Failed", { exact:true }).waitFor();

    await panel.getByRole("button", { name:"Unlink conversation" }).click();
    await panel.getByText("Not paired", { exact:true }).waitFor();
    automation.companion.activeActionId = "unrelated-action";
    await panel.locator("#automation-capabilities:disabled").waitFor();
    assert.equal(await panel.getByRole("button", { name:"Open in ChatGPT" }).isDisabled(), true);
    automation.companion.authenticated = false;
    await model.locator("option").filter({hasText:"Saved model"}).waitFor({state:"attached"});
    assert.equal(await model.locator("option:checked").textContent(), "Saved model");
    assert.equal(await effort.locator("option:checked").textContent(), "Saved effort");
    assert(operations.includes("capabilities"));
    assert(operations.includes("reveal"));
    assert(operations.some(entry => Array.isArray(entry) && entry[0] === "selection"));
    assert(operations.some(entry => Array.isArray(entry) && entry[0] === "pair"));
    assert(operations.some(entry => Array.isArray(entry) && entry[0] === "unlink"));
    assert(operations.some(entry => Array.isArray(entry) && entry[0] === "cancel"));
    assert(operations.some(entry => Array.isArray(entry) && entry[0] === "retry"));
    assert.deepEqual(operations.filter(entry => Array.isArray(entry) && entry[0] === "send").map(entry => entry[1]), [
      "/goal set Finish the standalone controls.", "/goal run", "/goal stop", "/goal clear"
    ]);
    const bodyText = await page.locator("body").textContent();
    assert(!bodyText.includes("owner_account_1"));
    assert(!bodyText.includes("Bearer test-token"));

    await page.setViewportSize({ width:640, height:800 });
    const box = await panel.locator("#composer").boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= 640);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
}
