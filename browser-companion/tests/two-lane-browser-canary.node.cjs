// Two browser processes, two disposable profiles, no real ChatGPT traffic.
// The production companion and its private profile are never touched.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { chromium } = require("patchright");

function independentProfile(label) {
  const root = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(root, "codexify-lane-" + label + "-"));
  const stats = fs.lstatSync(profile);
  assert.equal(stats.isDirectory() && !stats.isSymbolicLink(), true);
  assert.equal(path.dirname(fs.realpathSync(profile)), root);
  return profile;
}

function chromeExecutable() {
  const paths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return paths.find(candidate => fs.existsSync(candidate));
}

async function browserLane(profile, localOrigin) {
  const executablePath = chromeExecutable();
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chrome",
    ...(executablePath ? { executablePath } : {}),
    viewport: { width: 800, height: 600 },
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === localOrigin) return route.continue();
    return route.abort();
  });
  return context;
}

test("two isolated Chromium browser lanes allow overlapping local work but share one Send gate", { timeout: 120000 }, async () => {
  const profileA = independentProfile("a");
  const profileB = independentProfile("b");
  const pending = [];
  let contextA, contextB;
  const httpServer = http.createServer((request, response) => {
    if (request.url.startsWith("/hold")) {
      pending.push(response);
      if (pending.length === 2) {
        for (const result of pending) {
          result.writeHead(200, { "Content-Type": "text/html" });
          result.end("<!doctype html><title>Local lane</title><main>isolated</main>");
        }
      }
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Local lane</title><main>isolated</main>");
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  try {
    [contextA, contextB] = await Promise.all([
      browserLane(profileA, origin), browserLane(profileB, origin),
    ]);
    assert.notEqual(contextA.browser(), contextB.browser(), "must use two distinct browser instances");
    const pageA = contextA.pages()[0] ?? await contextA.newPage();
    const pageB = contextB.pages()[0] ?? await contextB.newPage();

    // Neither local fixture request can complete until BOTH lanes reach it.
    let timeout;
    try {
      await Promise.race([
        Promise.all([pageA.goto(origin + "/hold?a"), pageB.goto(origin + "/hold?b")]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Second browser never advanced concurrently")), 18000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(pending.length, 2);
    assert.equal(await pageA.title(), "Local lane");
    assert.equal(await pageB.title(), "Local lane");

    await pageA.evaluate(() => {
      localStorage.setItem("canary-only", "lane-A");
      document.cookie = "canary=A";
    });
    assert.equal(await pageB.evaluate(() => localStorage.getItem("canary-only")), null);
    assert.equal(await pageB.evaluate(() => document.cookie.includes("canary=A")), false);
    await pageB.evaluate(() => localStorage.setItem("canary-only", "lane-B"));
    assert.equal(await pageA.evaluate(() => localStorage.getItem("canary-only")), "lane-A");
    assert.equal(await pageB.evaluate(() => localStorage.getItem("canary-only")), "lane-B");

    // Simulate one global provider Send budget. No ChatGPT requests occur.
    let active = 0;
    let maxActive = 0;
    let tail = Promise.resolve();
    async function globallyAdmittedSend(label) {
      let release;
      const prior = tail;
      tail = new Promise(resolve => { release = resolve; });
      await prior;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        return label;
      } finally {
        active--;
        release();
      }
    }
    const result = await Promise.all([
      globallyAdmittedSend("a1"), globallyAdmittedSend("b1"),
      globallyAdmittedSend("a2"), globallyAdmittedSend("b2"),
    ]);
    assert.deepEqual(result, ["a1", "b1", "a2", "b2"]);
    assert.equal(maxActive, 1, "provider Send gate must serialize across both lanes");
    console.log("CANARY two independent browsers and profiles; local parallel navigation; global Send admission max=1: PASS");
  } finally {
    for (const context of [contextA, contextB]) {
      if (context) await context.close().catch(() => {});
    }
    await new Promise(resolve => httpServer.close(resolve));
    for (const profile of [profileA, profileB]) {
      const actual = fs.realpathSync(profile);
      const root = fs.realpathSync(os.tmpdir());
      if (path.dirname(actual) !== root || !path.basename(actual).startsWith("codexify-lane-")) {
        throw new Error("Refusing to clean a profile outside the test root");
      }
      fs.rmSync(actual, { recursive: true, force: false });
    }
  }
});
