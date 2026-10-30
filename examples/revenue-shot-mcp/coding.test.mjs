import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import { createCodingService } from "./coding.mjs";
import { makeHandler } from "./server.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(t, enabled = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codexify-direct-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "geo");
  const shot = path.join(root, ".revenue-shot");
  const src = path.join(root, "src");
  await fs.mkdir(shot, { recursive: true });
  await fs.mkdir(src, { recursive: true });
  const state = path.join(shot, "CURRENT_STATE.md");
  const journal = path.join(shot, "RUN_JOURNAL.md");
  const file = path.join(src, "index.ts");
  await fs.writeFile(state, "LAST_RUN_KEY: previous-20261030-aaaa\n");
  await fs.writeFile(journal, "RUN_START_V3\nRUN_KEY: previous-20261030-aaaa\nRUN_NOTE_V3\nRUN_KEY: previous-20261030-aaaa\n");
  await fs.writeFile(path.join(shot, "MASTER_PLAN.md"), "plan\n");
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "policy\n");
  await fs.writeFile(file, "const alpha = 1;\nconst beta = 2;\n");
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_SENTINEL\n");
  const config = {
    projects: { geo: root },
    coding: { geo: {
      readPrefixes: ["src/", "README.md"],
      writePrefixes: ["src/"],
      gitRoots: { root: "." },
      checks: { smoke: { executable: process.execPath,
        args: ["-e", "process.stdout.write('CHECK_OK')"], timeoutMs: 3000 } }
    } },
    enableWrites: false, enableCodingRead: enabled.read === true,
    enableCodingWrites: enabled.write === true,
    enableProjectChecks: enabled.check === true
  };
  const preconditions = async () => ({
    expected_state_sha256: sha(await fs.readFile(state)),
    expected_journal_sha256: sha(await fs.readFile(journal))
  });
  return { config, service: createCodingService(config),
    root, shot, file, state, journal, temp, preconditions };
}

test("read_project_file serves bounded complete lines from a configured root", async t => {
  const f = await fixture(t, { read: true });
  const result = await f.service.read_project_file({
    project: "geo", path: "src/index.ts", offset: 0, limit: 1
  });
  assert.equal(result.content, "const alpha = 1;");
  assert.equal(result.sha256, sha(await fs.readFile(f.file)));
  assert.equal(result.returnedLines, 1);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.truncated, true);
  const next = await f.service.read_project_file({
    project: "geo", path: "src/index.ts", offset: 1, limit: 5
  });
  assert.ok(next.content.includes("const beta = 2;"));
  assert.equal(next.truncated, false);
});

test("fixed project reads deny traversal, secrets, arbitrary paths and oversized lines", async t => {
  const f = await fixture(t, { read: true });
  const bad = [".env", "../outside", "src/../../private",
    "src\\index.ts", "src//index.ts", "src/../index.ts", "other/file.ts"];
  for (const name of bad) {
    await assert.rejects(f.service.read_project_file({
      project: "geo", path: name
    }), /DISALLOWED|INVALID|FILE_NOT_ALLOWLISTED/);
  }
  await assert.rejects(f.service.read_project_file({
    project: "unknown", path: "src/index.ts"
  }), /UNKNOWN_PROJECT/);
  await fs.writeFile(f.file, "X".repeat(17000));
  await assert.rejects(f.service.read_project_file({
    project: "geo", path: "src/index.ts"
  }), /SOURCE_LINE_TOO_LARGE/);
  await fs.writeFile(f.file, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(f.service.read_project_file({
    project: "geo", path: "src/index.ts"
  }), /NON_UTF8_SOURCE_NOT_ALLOWED/);
});

test("symlinked source paths are rejected rather than read", async t => {
  const f = await fixture(t, { read: true });
  const outside = path.join(f.temp, "outside.txt");
  await fs.writeFile(outside, "PRIVATE_SENTINEL\n");
  const link = path.join(f.root, "src", "linked.ts");
  try { await fs.symlink(outside, link, "file"); }
  catch (e) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(e.code)) {
      t.skip("OS does not permit test symlinks");
      return;
    }
    throw e;
  }
  await assert.rejects(f.service.read_project_file({
    project: "geo", path: "src/linked.ts"
  }), /REDIRECTED_OR_UNSAFE_PATH/);
});

test("Git inspection returns fixed repo HEAD without arbitrary Git arguments", async t => {
  const f = await fixture(t, { read: true });
  const git = (...args) => execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "src/index.ts");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "-qm", "test fixture");
  const result = await f.service.inspect_project_git({ project: "geo" });
  assert.equal(result.head, git("rev-parse", "HEAD"));
  assert.equal(result.writerStatus, "UNKNOWN");
  await fs.writeFile(f.file, "const alpha = 100;\n");
  const changed = await f.service.inspect_project_git({ project: "geo", repository: "root" });
  assert.match(changed.trackedChanges, /src\/index.ts/);
  await assert.rejects(f.service.inspect_project_git({
    project: "geo", repository: "../../private"
  }), /INVALID_GIT_ALIAS/);
  await assert.rejects(f.service.inspect_project_git({
    project: "geo", repository: "companion"
  }), /UNKNOWN_GIT_REPOSITORY/);
});

test("project checks require exact operator selection and ledger preconditions", async t => {
  const f = await fixture(t, { read: true, check: true });
  const conditions = await f.preconditions();
  const good = await f.service.run_project_check({
    project: "geo", check_id: "smoke", ...conditions
  });
  assert.equal(good.exitCode, 0);
  assert.equal(good.timedOut, false);
  assert.equal(good.stdout, "CHECK_OK");
  await assert.rejects(f.service.run_project_check({
    project: "geo", check_id: "node --eval", ...conditions
  }), /UNKNOWN_PROJECT_CHECK/);
  await fs.appendFile(f.state, "CHANGED\n");
  await assert.rejects(f.service.run_project_check({
    project: "geo", check_id: "smoke", ...conditions
  }), /LEDGER_PRECONDITION_CHANGED/);
  const lock = path.join(f.shot, ".codexify-project-check.lock");
  assert.equal(await fs.stat(lock).catch(() => null), null);
});

test("optional source editing is exact-unique, digest guarded and preserves journal", async t => {
  const f = await fixture(t, { read: true, write: true });
  const beforeJournal = await fs.readFile(f.journal);
  const before = await fs.readFile(f.file);
  const request = {
    project: "geo", path: "src/index.ts",
    expected_sha256: sha(before), ...(await f.preconditions()),
    find: "const alpha = 1;", replacement: "const alpha = 3;"
  };
  const result = await f.service.apply_project_edit(request);
  assert.equal(result.status, "UPDATED");
  assert.equal(result.previousSha256, sha(before));
  assert.match(await fs.readFile(f.file, "utf8"), /alpha = 3/);
  await assert.rejects(f.service.apply_project_edit(request), /SOURCE_PRECONDITION_CHANGED/);
  assert.deepEqual(await fs.readFile(f.journal), beforeJournal);
  assert.equal(await fs.stat(path.join(f.shot, ".codexify-source-edit.lock")).catch(() => null), null);
});

test("source edits reject duplicate context, stale ledger and unallowlisted files", async t => {
  const f = await fixture(t, { write: true });
  await fs.writeFile(f.file, "needle needle\n");
  const conditions = await f.preconditions();
  const original = await fs.readFile(f.file);
  const edit = { project: "geo", path: "src/index.ts", expected_sha256: sha(original),
    ...conditions, find: "needle", replacement: "changed" };
  await assert.rejects(f.service.apply_project_edit(edit), /EDIT_CONTEXT_NOT_UNIQUE/);
  await assert.rejects(f.service.apply_project_edit({
    ...edit, path: ".env"
  }), /DISALLOWED_PATH_COMPONENT/);
  await fs.appendFile(f.state, "other writer\n");
  await assert.rejects(f.service.apply_project_edit({
    ...edit, find: "needle needle"
  }), /LEDGER_PRECONDITION_CHANGED/);
  assert.deepEqual(await fs.readFile(f.file), original);
});

test("concurrent exact-hash source edits cannot both overwrite the same file", async t => {
  const f = await fixture(t, { write: true });
  const before = await fs.readFile(f.file);
  const edit = { project: "geo", path: "src/index.ts",
    expected_sha256: sha(before), ...(await f.preconditions()),
    find: "const alpha = 1;", replacement: "const alpha = 7;" };
  const otherService = createCodingService(f.config);
  const results = await Promise.allSettled([
    f.service.apply_project_edit(edit), otherService.apply_project_edit(edit)
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.some(r => r.status === "rejected" &&
    /SOURCE_EDIT_LOCK_PRESENT|SOURCE_PRECONDITION_CHANGED/.test(String(r.reason))));
  assert.match(await fs.readFile(f.file, "utf8"), /alpha = 7/);
  const leftovers = (await fs.readdir(path.dirname(f.file)))
    .filter(name => name.includes(".codexify-"));
  assert.deepEqual(leftovers, []);
});

test("coding permissions default to disabled even with an operator map", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.read_project_file({
    project: "geo", path: "src/index.ts"
  }), /CODING_READ_DISABLED/);
  await assert.rejects(f.service.run_project_check({
    project: "geo", check_id: "smoke"
  }), /PROJECT_CHECKS_DISABLED/);
  await assert.rejects(f.service.apply_project_edit({
    project: "geo", path: "src/index.ts"
  }), /CODING_WRITES_DISABLED/);
  const handler = makeHandler(f.config);
  const tools = (await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.length, 3);
});

test("MCP exposes each operator-enabled tool with accurate annotation", async t => {
  const f = await fixture(t, { read: true, write: true, check: true });
  const handler = makeHandler(f.config);
  const tools = (await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  assert.deepEqual(tools.map(item => item.name),
    ["inspect_project_writer", "read_project_policy", "get_run_ledger_status",
      "read_project_file", "inspect_project_git", "run_project_check",
      "apply_project_edit"]);
  const byName = name => tools.find(item => item.name === name);
  assert.equal(byName("read_project_file").annotations.readOnlyHint, true);
  assert.equal(byName("inspect_project_git").annotations.openWorldHint, false);
  assert.equal(byName("run_project_check").annotations.readOnlyHint, false);
  assert.equal(byName("run_project_check").annotations.openWorldHint, true);
  assert.equal(byName("apply_project_edit").annotations.destructiveHint, true);
  assert.equal(Object.hasOwn(byName("run_project_check").inputSchema.properties, "command"), false);
  const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "read_project_file", arguments: {
      project: "geo", path: "src/index.ts", limit: 1
    } } });
  assert.equal(result.result.structuredContent.content, "const alpha = 1;");
  const failure = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "read_project_file", arguments: {
      project: "geo", path: "../private"
    } } });
  assert.equal(failure.result.isError, true);
});

test("stdio MCP transport advertises and executes a native read_project_file call", async t => {
  const f = await fixture(t, { read: true });
  const configFile = path.join(f.temp, "read-only-coding.json");
  await fs.writeFile(configFile, JSON.stringify(f.config));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, REVENUE_SHOT_PROJECTS_FILE: configFile }
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const stream = readline.createInterface({ input: child.stdout });
  const iterator = stream[Symbol.asyncIterator]();
  const send = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const next = await iterator.next();
    assert.equal(next.done, false);
    return JSON.parse(next.value);
  };
  const initialized = await send(1, "initialize", { protocolVersion: "2025-11-25" });
  assert.equal(initialized.result.serverInfo.version, "0.3.0");
  const listed = await send(2, "tools/list", {});
  assert.ok(listed.result.tools.some(x => x.name === "read_project_file"));
  assert.ok(listed.result.tools.every(x => x.name !== "apply_project_edit"));
  const read = await send(3, "tools/call", {
    name: "read_project_file",
    arguments: { project: "geo", path: "src/index.ts", limit: 1 }
  });
  assert.equal(read.result.structuredContent.content, "const alpha = 1;");
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("exit " + code)));
    child.once("error", reject);
  });
});
