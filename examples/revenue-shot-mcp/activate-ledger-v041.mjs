// Reversible, schema-compatible ledger hotfix for the ONE existing direct bridge.
// Does not start/stop Codexify, modify scheduled tasks, or grant write tools.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readonlyFleetConfig } from "./coding-profile.mjs";

const ACTION = process.argv[2];
const root = path.join(os.homedir(), ".codexify");
const oldDir = path.join(root, "revenue-shot-direct-v04");
const stageDir = path.join(root, "revenue-shot-direct-v041");
const sourceDir = import.meta.dirname;
const configFile = path.join(root, "codexify.config.json");
const backupFile = path.join(stageDir, "codexify.config.before-direct-v041.json");
const oldProjects = path.join(oldDir, "projects.json");
const stagedProjects = path.join(stageDir, "projects.json");
const stagedServer = path.join(stageDir, "server.mjs");
const staticTools = ["read_project_policy", "inspect_project_writer", "get_run_ledger_status"];
const oldReadTools = ["read_project_file", "inspect_project_git", "read_project_journal",
  "inspect_project_worktrees", "read_project_worktree_file"];
const readTools = [...oldReadTools];

function hash(data) { return createHash("sha256").update(data).digest("hex"); }
function ensure(condition, code) { if (!condition) throw new Error(code); }
function equalPaths(a, b) {
  const norm = value => process.platform === "win32"
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return norm(a) === norm(b);
}
async function ordinary(pathname, file = false) {
  const st = await fs.lstat(pathname);
  ensure(!st.isSymbolicLink() && (file ? st.isFile() : st.isDirectory()),
    "UNSAFE_FILE_OR_DIRECTORY");
  ensure(equalPaths(pathname, await fs.realpath(pathname)), "REDIRECTED_PATH");
}
async function writeNewOrEqual(file, bytes) {
  try {
    const old = await fs.readFile(file);
    ensure(hash(old) === hash(bytes), "STAGED_FILE_CONTENT_CONFLICT");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  }
}
async function atomicReplace(file, bytes, expectedHash) {
  ensure(hash(await fs.readFile(file)) === expectedHash, "CONFIG_CHANGED_DURING_PREPARE");
  const temp = file + ".codexify-v041.tmp";
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    ensure(hash(await fs.readFile(file)) === expectedHash, "CONFIG_CONCURRENT_UPDATE");
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
  ensure(hash(await fs.readFile(file)) === hash(bytes), "CONFIG_POSTCONDITION_AMBIGUOUS");
}
function inspectBridge(json) {
  const peer = json?.mcpServers?.revenue_shot_preflight;
  ensure(peer && peer.mode === "direct", "WRONG_BRIDGE_MODE");
  ensure(Array.isArray(peer.args) && peer.args.length === 1, "UNEXPECTED_BRIDGE_ARGS");
  ensure(peer.env && typeof peer.env.REVENUE_SHOT_PROJECTS_FILE === "string",
    "MISSING_PRIVATE_CONFIG_REFERENCE");
  ensure(Array.isArray(peer.tools), "INVALID_BRIDGE_ALLOWLIST");
  return peer;
}
async function stage() {
  await ordinary(root);
  await ordinary(oldDir);
  await ordinary(oldProjects, true);
  await ordinary(configFile, true);
  const original = JSON.parse(await fs.readFile(oldProjects, "utf8"));
  const config = readonlyFleetConfig(original);
  await fs.mkdir(stageDir, { recursive: true });
  await ordinary(stageDir);
  for (const name of ["server.mjs", "ledger.mjs", "coding.mjs",
    "coding-profile.mjs", "smoke-coding-readonly.mjs",
    "smoke-ledger-v041.mjs", "package.json"]) {
    const src = path.join(sourceDir, name);
    await ordinary(src, true);
    await writeNewOrEqual(path.join(stageDir, name), await fs.readFile(src));
  }
  await writeNewOrEqual(stagedProjects, Buffer.from(JSON.stringify(config, null, 2) + "\n"));
  ensure(config.enableCodingRead === true && config.enableCodingWrites === false
    && config.enableProjectChecks === false && config.enableWrites === false,
  "STAGE_MUST_REMAIN_READ_ONLY");
  process.stdout.write("STAGED_V041: schema-compatible V1/V3 ledger fix; old v0.4 sidecar preserved\n");
}
async function activate() {
  await ordinary(stageDir);
  await ordinary(stagedServer, true);
  await ordinary(stagedProjects, true);
  await ordinary(configFile, true);
  const staged = JSON.parse(await fs.readFile(stagedProjects, "utf8"));
  ensure(staged.enableWrites === false && staged.enableCodingRead === true
    && staged.enableCodingWrites === false && staged.enableProjectChecks === false,
    "UNSAFE_STAGED_FLAGS");
  const originalBytes = await fs.readFile(configFile);
  const originalHash = hash(originalBytes);
  const config = JSON.parse(originalBytes.toString("utf8"));
  const old = inspectBridge(config);
  ensure(equalPaths(old.args[0], path.join(oldDir, "server.mjs")), "UNEXPECTED_ACTIVE_SERVER");
  ensure(equalPaths(old.env.REVENUE_SHOT_PROJECTS_FILE, oldProjects),
    "UNEXPECTED_PROJECTS_FILE");
  ensure([...old.tools].sort().join("|") === [...staticTools, ...oldReadTools].sort().join("|"),
    "UNEXPECTED_ACTIVE_TOOLS");
  await writeNewOrEqual(backupFile, originalBytes);
  const updated = structuredClone(config);
  const bridge = updated.mcpServers.revenue_shot_preflight;
  bridge.args = [stagedServer];
  bridge.env.REVENUE_SHOT_PROJECTS_FILE = stagedProjects;
  bridge.tools = [...staticTools, ...readTools];
  const output = Buffer.from(JSON.stringify(updated, null, 2) + "\n");
  await atomicReplace(configFile, output, originalHash);
  process.stdout.write("CONFIG_V041_ACTIVATED: same tunnel and same 8 read-only direct tools; restart NOT attempted\n");
}
async function rollback() {
  await ordinary(backupFile, true);
  await ordinary(configFile, true);
  const bytes = await fs.readFile(configFile);
  const config = JSON.parse(bytes.toString("utf8"));
  const bridge = inspectBridge(config);
  ensure(equalPaths(bridge.args[0], stagedServer), "NOT_RUNNING_STAGED_BRIDGE");
  ensure(equalPaths(bridge.env.REVENUE_SHOT_PROJECTS_FILE, stagedProjects),
    "UNEXPECTED_PROJECTS_FILE");
  ensure([...bridge.tools].sort().join("|") === [...staticTools, ...readTools].sort().join("|"),
    "UNEXPECTED_CURRENT_TOOLS");
  await atomicReplace(configFile, await fs.readFile(backupFile), hash(bytes));
  process.stdout.write("CONFIG_V041_ROLLED_BACK: original v0.4 direct bridge restored; restart NOT attempted\n");
}
if (ACTION === "stage") await stage();
else if (ACTION === "activate") await activate();
else if (ACTION === "rollback") await rollback();
else {
  process.stderr.write("Usage: node activate-readonly.mjs stage|activate|rollback\n");
  process.exitCode = 2;
}
