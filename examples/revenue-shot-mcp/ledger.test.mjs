import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createRevenueService, loadRevenueConfig } from "./ledger.mjs";
import { makeHandler } from "./server.mjs";

const PREVIOUS = "previous-20261028-1234";
const NEXT = "current-20261028-5678";
const MARKER = "RUN_START_V3\nRUN_KEY: " + NEXT + "\nSTATUS: STARTED\n";
const sha = data => createHash("sha256").update(data).digest("hex");

async function fixture(t, enabled = true) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shot-mcp-"));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "geo");
  const shot = path.join(root, ".revenue-shot");
  await fs.mkdir(shot, { recursive: true });
  const journal = path.join(shot, "RUN_JOURNAL.md");
  const state = path.join(shot, "CURRENT_STATE.md");
  await fs.writeFile(journal, "# journal\nRUN_START_V3\nRUN_KEY: " + PREVIOUS
    + "\nSTATUS: TERMINAL\n");
  await fs.writeFile(state, "LAST_COMPLETED_RUN_KEY: " + PREVIOUS + "\n");
  await fs.writeFile(path.join(shot, "MASTER_PLAN.md"), "The security plan\n");
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "Local owner rules\n");
  const config = { projects: { geo: root }, enableWrites: enabled };
  const service = createRevenueService(config);
  const snapshot = async () => ({
    journal: await fs.readFile(journal, "utf8"),
    state: await fs.readFile(state, "utf8")
  });
  const args = async () => {
    const { journal, state } = await snapshot();
    return { project: "geo", run_key: NEXT, predecessor_run_key: PREVIOUS,
      expected_journal_sha256: sha(journal), expected_state_sha256: sha(state),
      record: MARKER };
  };
  return { config, service, shot, journal, state, snapshot, args, temp };
}

test("bounded preflight reads advertise evidence without claiming writer absence", async t => {
  const { service, snapshot } = await fixture(t);
  const before = await snapshot();
  const policy = await service.read_project_policy({
    project: "geo", document: "master_plan", limit: 4
  });
  assert.equal(policy.content, "The security plan\n");
  assert.equal(policy.sha256.length, 64);
  const ledger = await service.get_run_ledger_status({ project: "geo" });
  assert.equal(ledger.runStartMarkers, 1);
  assert.equal(ledger.stateSha256, sha(before.state));
  const writer = await service.inspect_project_writer({ project: "geo" });
  assert.equal(writer.writerStatus, "UNKNOWN");
  assert.equal(writer.externalWriterVerified, false);
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(service.read_project_policy({
    project: "geo", document: "../../outside"
  }), /UNSUPPORTED_POLICY_DOCUMENT/);
  await assert.rejects(service.read_project_policy({
    project: "geo", document: "master_plan", limit: 9999
  }), /INVALID_READ_WINDOW/);
  await assert.rejects(service.get_run_ledger_status({
    project: "../other"
  }), /UNKNOWN_PROJECT/);
});

test("long policy pages resume at complete-line boundaries without losing text", async t => {
  const { service, shot } = await fixture(t);
  const content = Array.from({ length: 100 },
    (_, i) => "line" + String(i).padStart(3, "0") + " " + "x".repeat(345)).join("\n");
  await fs.writeFile(path.join(shot, "MASTER_PLAN.md"), content);
  let offset = 0;
  const sections = [];
  let pageCount = 0;
  while (true) {
    const page = await service.read_project_policy({
      project: "geo", document: "master_plan", offset, limit: 180
    });
    assert.equal(page.offset, offset);
    assert.ok(page.content.length <= 16000);
    assert.ok(page.returnedLines > 0);
    assert.equal(page.nextOffset, offset + page.returnedLines);
    sections.push(page.content);
    pageCount += 1;
    offset = page.nextOffset;
    if (!page.truncated) break;
  }
  assert.ok(pageCount > 1);
  assert.equal(sections.join("\n"), content);
  assert.equal(offset, 100);
});

test("append exactly once and make an exact-tail replay a no-op", async t => {
  const { service, args, snapshot } = await fixture(t);
  const inputs = await args();
  const first = await service.append_run_record(inputs);
  assert.equal(first.status, "APPENDED");
  const after = await snapshot();
  assert.ok(after.journal.endsWith(MARKER));
  assert.equal(after.journal.split("RUN_KEY: " + NEXT).length - 1, 1);
  const repeat = await service.append_run_record(inputs);
  assert.equal(repeat.status, "ALREADY_APPLIED");
  assert.equal(repeat.appendedBytes, 0);
  assert.deepEqual(await snapshot(), after);
});

test("stale state/journal hashes and false predecessor reject without mutation", async t => {
  const { service, args, snapshot } = await fixture(t);
  const before = await snapshot();
  const good = await args();
  await assert.rejects(service.append_run_record({
    ...good, expected_journal_sha256: "0".repeat(64)
  }), /PRECONDITION_DIGEST_MISMATCH/);
  await assert.rejects(service.append_run_record({
    ...good, predecessor_run_key: "absent-20261028-0000"
  }), /PREDECESSOR_NOT_FOUND/);
  await assert.rejects(service.append_run_record({
    ...good, record: "RUN_KEY: some-other-run\nSTATUS: STARTED\n"
  }), /RECORD_RUN_KEY_MISMATCH/);
  assert.deepEqual(await snapshot(), before);
});

test("write disabled by default or config blocks any journal modification", async t => {
  const { service, snapshot, args } = await fixture(t, false);
  const before = await snapshot();
  await assert.rejects(service.append_run_record(await args()), /JOURNAL_WRITES_DISABLED/);
  assert.deepEqual(await snapshot(), before);
});

test("existing sidecar lock fails closed and signals UNKNOWN ownership", async t => {
  const { service, args, shot, snapshot } = await fixture(t);
  const before = await snapshot();
  const lock = path.join(shot, ".codexify-journal-append.lock");
  await fs.writeFile(lock, "some other owner\n");
  const writer = await service.inspect_project_writer({ project: "geo" });
  assert.equal(writer.sidecarLockPresent, true);
  await assert.rejects(service.append_run_record(await args()),
    /WRITER_LOCK_BUSY_OR_STALE/);
  assert.deepEqual(await snapshot(), before);
});

test("simultaneous callers cannot append the same record twice", async t => {
  const { config, args, snapshot } = await fixture(t);
  const input = await args();
  const services = [createRevenueService(config), createRevenueService(config)];
  const results = await Promise.allSettled(services.map(s => s.append_run_record(input)));
  const success = results.filter(r => r.status === "fulfilled");
  assert.ok(success.length >= 1);
  assert.ok(results.filter(r => r.status === "rejected").every(r =>
    String(r.reason).includes("WRITER_LOCK_BUSY_OR_STALE")));
  const { journal } = await snapshot();
  assert.equal(journal.split("RUN_KEY: " + NEXT).length - 1, 1);
});

test("two OS processes sharing the sidecar lock append at most once", async t => {
  const { config, args, snapshot, temp } = await fixture(t);
  const configPath = path.join(temp, "shared-config.json");
  const requestPath = path.join(temp, "shared-request.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(requestPath, JSON.stringify(await args()));
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [path.join(import.meta.dirname, "worker-append.mjs"), configPath, requestPath],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
    child.once("exit", code => resolve({ code, output: output.trim() }));
    child.once("error", reject);
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(r => r.output === "APPENDED").length, 1);
  assert.ok(results.every(r => ["APPENDED", "ALREADY_APPLIED",
    "WRITER_LOCK_BUSY_OR_STALE"].includes(r.output)));
  assert.equal((await snapshot()).journal.split("RUN_KEY: " + NEXT).length - 1, 1);
});

test("a redirected journal is refused rather than read or appended", async t => {
  const { service, journal, temp, args } = await fixture(t);
  const outside = path.join(temp, "outside.md");
  await fs.writeFile(outside, "private fixture outside project");
  await fs.rename(journal, journal + ".original");
  try {
    await fs.symlink(outside, journal, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("symlinks not permitted in this environment");
      return;
    }
    throw error;
  }
  await assert.rejects(service.get_run_ledger_status({ project: "geo" }),
    /UNSAFE_OR_OVERSIZED_FILE/);
  await assert.rejects(service.append_run_record(await args()),
    /UNSAFE_OR_OVERSIZED_FILE/);
  assert.equal(await fs.readFile(outside, "utf8"), "private fixture outside project");
});

test("MCP schema uses separate accurate risk hints and write opt-in", async t => {
  const { config } = await fixture(t);
  const handler = makeHandler(config);
  const initialize = await handler({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25" } });
  assert.equal(initialize.result.protocolVersion, "2025-11-25");
  const output = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = output.result.tools;
  assert.equal(tools.length, 4);
  const read = tools.find(x => x.name === "read_project_policy");
  const write = tools.find(x => x.name === "append_run_record");
  assert.deepEqual(read.annotations, { readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false });
  assert.deepEqual(write.annotations, { readOnlyHint: false, destructiveHint: true,
    idempotentHint: false, openWorldHint: false });
  assert.equal(read.inputSchema.additionalProperties, false);
  assert.deepEqual(read.inputSchema.properties.project.enum, ["geo"]);
  assert.equal(makeHandler({ ...config, enableWrites: false }) === undefined, false);
  const hidden = await makeHandler({ ...config, enableWrites: false })({
    jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(hidden.result.tools.length, 3);
});

test("stdio transport completes initialize, discovery and bounded call", async t => {
  const { config, temp } = await fixture(t, false);
  const configPath = path.join(temp, "config.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  assert.deepEqual(await loadRevenueConfig(configPath), config);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")],
    { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, REVENUE_SHOT_PROJECTS_FILE: configPath } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const send = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const next = await iterator.next();
    assert.equal(next.done, false);
    return JSON.parse(next.value);
  };
  const init = await send(1, "initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.serverInfo.name, "revenue-shot-scoped");
  const toolList = await send(2, "tools/list", {});
  assert.equal(toolList.result.tools.length, 3);
  const status = await send(3, "tools/call", {
    name: "get_run_ledger_status", arguments: { project: "geo" }
  });
  assert.equal(status.result.structuredContent.project, "geo");
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("exit " + code)));
    child.once("error", reject);
  });
});


test("owner-gated kernel attestation is digest pinned, paged and read-only", async t => {
  const { config, snapshot, temp } = await fixture(t, false);
  const kernelPath = path.join(temp, "original-kernel.json");
  const text = JSON.stringify({
    id: "geo-scheduled-task-20260922",
    prompt: "A\\u2728" + "\\u{1F680}".repeat(4500)
  });
  await fs.writeFile(kernelPath, text, "utf8");
  const pinned = { ...config, enableKernelAttestation: true,
    kernelFiles: { geo: { path: kernelPath, sha256: sha(text) } } };
  const service = createRevenueService(pinned);
  const before = await snapshot();

  const disabled = createRevenueService({ ...pinned, enableKernelAttestation: false });
  await assert.rejects(disabled.read_original_kernel({ project: "geo" }),
    /KERNEL_ATTESTATION_DISABLED/);
  const disabledHandler = makeHandler({ ...pinned, enableKernelAttestation: false });
  const disabledList = await disabledHandler({
    jsonrpc: "2.0", id: 1, method: "tools/list"
  });
  assert.ok(!disabledList.result.tools.some(tool => tool.name === "read_original_kernel"));

  const handler = makeHandler(pinned);
  const list = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tool = list.result.tools.find(item => item.name === "read_original_kernel");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.project.enum, ["geo"]);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, "path"), false);
  const chunks = [];
  let offset = 0;
  let sha256;
  while (true) {
    const page = await service.read_original_kernel({ project: "geo", offset, limit: 2800 });
    assert.equal(page.digestVerified, true);
    sha256 = page.sha256;
    chunks.push(page.content);
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
    if (!page.truncated) break;
  }
  assert.equal(chunks.join(""), text);
  assert.equal(sha256, sha(text));
  assert.deepEqual(await snapshot(), before);

  await assert.rejects(service.read_original_kernel({ project: "gsc" }), /UNKNOWN_PROJECT/);
  await assert.rejects(service.read_original_kernel({
    project: "geo", offset: -1
  }), /INVALID_KERNEL_READ_WINDOW/);
  await assert.rejects(service.read_original_kernel({
    project: "geo", offset: 0, limit: 99999
  }), /INVALID_KERNEL_READ_WINDOW/);

  await fs.appendFile(kernelPath, " ");
  await assert.rejects(service.read_original_kernel({ project: "geo" }),
    /KERNEL_DIGEST_MISMATCH/);
});

test("kernel attestation rejects unpinned sources without touching journals", async t => {
  const { config, temp, snapshot } = await fixture(t, false);
  const before = await snapshot();
  const unpinned = createRevenueService({ ...config, enableKernelAttestation: true,
    kernelFiles: { geo: { path: path.join(temp, "untrusted.json") } } });
  await assert.rejects(unpinned.read_original_kernel({ project: "geo" }),
    /KERNEL_ATTESTATION_NOT_CONFIGURED/);
  assert.deepEqual(await snapshot(), before);
});
