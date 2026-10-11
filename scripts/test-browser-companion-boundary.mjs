import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const companion = join(root, "browser-companion");
const manifest = JSON.parse(await readFile(join(companion, "upstream-manifest.json"), "utf8"));

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

test("browser companion records one exact reviewed upstream boundary", async () => {
  assert.equal(manifest.repository, "miuuyy/codex-chatgpt-web");
  assert.equal(manifest.tag, "v6.1.7");
  assert.equal(manifest.commit, "f9ad4ae83a579287105ad822dd0c3e0029b04ef6");
  for (const entry of [...manifest.wholeFiles, ...manifest.derivedSymbols]) {
    const local = await readFile(join(root, entry.local), "utf8");
    assert.match(local, new RegExp(manifest.commit), entry.local);
  }
  const notice = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notice, /miuuyy\/codex-chatgpt-web/);
  assert.match(notice, new RegExp(manifest.commit));
  const license = await readFile(join(root, "LICENSES", "codex-chatgpt-web-MIT.txt"), "utf8");
  assert.match(license, /Permission is hereby granted, free of charge/);
});

test("companion source contains no imported Responses, Codex, tunnel, subagent, or tab-pool system", async () => {
  const sources = (await filesBelow(join(companion, "src"))).filter(path => /\.(?:ts|d\.ts)$/.test(path));
  const combined = (await Promise.all(sources.map(path => readFile(path, "utf8")))).join("\n");
  for (const forbidden of [
    /MAX_CHATGPT_BROWSER_TABS/,
    /retainConversation/,
    /requireRetainedConversation/,
    /CodexProviderConfig/,
    /Responses API/,
    /\/v1\/responses/,
    /subagent/i,
    /tunnel-client/i,
    /from\s+["'][^"']*launcher-browser-host[^"']*["']/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.equal((combined.match(/launchPersistentContext\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(combined, /BrowserWindow|connectOverCDP/);
  assert.doesNotMatch(combined, /from\s+["'](?:\.\.\/){2,}/);
});

test("control protocol exposes only the approved loopback RPC surface", async () => {
  const control = await readFile(join(companion, "src", "control-server.ts"), "utf8");
  const expected = [
    "/v1/health",
    "/v1/session/login",
    "/v1/session/capabilities",
    "/v1/window/reveal",
    "/v1/actions/execute",
    "/v1/actions/cancel",
  ];
  for (const path of expected) assert.match(control, new RegExp(path.replaceAll("/", "\\/")));
  assert.match(control, /\/v1\\\/actions\\\//);
  assert.doesNotMatch(control, /javascript|cssSelector|cookie|filesystemPath/);
});

test("build artifact is optional, bounded, and does not vendor Electron or Patchright", async () => {
  const output = join(companion, "dist", "main.js");
  const metadata = await stat(output);
  assert(metadata.size > 0 && metadata.size < 1024 * 1024);
  const text = await readFile(output, "utf8");
  assert.match(text, /codexify-browser-companion/);
  assert.match(text, /patchright/);
  assert.match(text, /electron/);
  assert.doesNotMatch(text, /MAX_CHATGPT_BROWSER_TABS|\/v1\/responses|retainConversation/);
});
