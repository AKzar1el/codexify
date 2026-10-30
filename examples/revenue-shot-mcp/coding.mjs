// Optional, explicitly authorized fixed-project coding operations.
// No model-supplied shell commands, filesystem roots, or Git refspecs.
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFixedFile, resolveProject } from "./ledger.mjs";

const runFile = promisify(execFile);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16000;
const MAX_CHECK_MS = 24000;

function deny(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}
function hash(data) { return createHash("sha256").update(data).digest("hex"); }
function comparePath(a, b) {
  const normalize = p => process.platform === "win32"
    ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}
function relativeName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 260
      || name.includes("\\") || name.includes(":") || name.includes("\0")
      || name.startsWith("/") || name.includes("//")) deny("INVALID_RELATIVE_PATH");
  const segments = name.split("/");
  if (segments.some(part => part === "" || part === "." || part === ".."
      || part.startsWith(".") || /^(secrets?|credentials?|tokens?)$/i.test(part))) {
    deny("DISALLOWED_PATH_COMPONENT");
  }
  return segments;
}
function prefixesContain(prefixes, relative) {
  if (!Array.isArray(prefixes) || prefixes.length > 48) deny("INVALID_OPERATOR_ALLOWLIST");
  return prefixes.some(prefix => {
    if (typeof prefix !== "string") deny("INVALID_OPERATOR_ALLOWLIST");
    const dir = prefix.endsWith("/");
    const name = dir ? prefix.slice(0, -1) : prefix;
    relativeName(name);
    return dir ? relative.startsWith(prefix) : relative === prefix;
  });
}
async function existingPath(root, relative, kind) {
  const segments = relativeName(relative);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) {
      deny("REDIRECTED_OR_UNSAFE_PATH");
    }
    if (i === segments.length - 1) {
      if (kind === "file" && (!stat.isFile() || stat.size > MAX_FILE_BYTES)) {
        deny("UNSAFE_OR_OVERSIZED_SOURCE");
      }
      if (kind === "directory" && !stat.isDirectory()) deny("NOT_A_DIRECTORY");
    }
    if (!comparePath(current, await fs.realpath(current))) deny("REDIRECTED_OR_UNSAFE_PATH");
  }
  return current;
}
async function policyFor(config, name) {
  const project = await resolveProject(config, name);
  const policy = config.coding?.[name];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    deny("PROJECT_CODING_NOT_CONFIGURED");
  }
  return { ...project, policy };
}
async function permittedFile(config, args, kind) {
  const target = await policyFor(config, args?.project);
  const name = args?.path;
  if (!relativeName(name)) deny("INVALID_RELATIVE_PATH");
  const allow = kind === "read" ? target.policy.readPrefixes : target.policy.writePrefixes;
  if (!prefixesContain(allow, name)) deny("FILE_NOT_ALLOWLISTED");
  return { ...target, file: await existingPath(target.root, name, "file") };
}
async function readSource(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    deny("UNSAFE_OR_OVERSIZED_SOURCE");
  }
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) deny("BINARY_SOURCE_NOT_ALLOWED");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { deny("NON_UTF8_SOURCE_NOT_ALLOWED"); }
  return bytes;
}
function checkedWindow(args, contents) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 80;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000
      || !Number.isInteger(limit) || limit < 1 || limit > 180) deny("INVALID_READ_WINDOW");
  const lines = contents.toString("utf8").split(/\r?\n/);
  const returned = [];
  let size = 0;
  for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
    const next = Buffer.byteLength(lines[i], "utf8") + (returned.length ? 1 : 0);
    if (next > MAX_RESPONSE_BYTES && returned.length === 0) deny("SOURCE_LINE_TOO_LARGE");
    if (size + next > MAX_RESPONSE_BYTES) break;
    returned.push(lines[i]); size += next;
  }
  return { offset, lines: lines.length, returnedLines: returned.length,
    nextOffset: offset + returned.length, content: returned.join("\n"),
    truncated: offset + returned.length < lines.length };
}
function safeGitAlias(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    deny("INVALID_GIT_ALIAS");
  }
  return value;
}
async function gitDirectory(target, alias) {
  const configured = target.policy.gitRoots ?? { root: "." };
  const choice = safeGitAlias(alias ?? "root");
  if (!Object.hasOwn(configured, choice)) deny("UNKNOWN_GIT_REPOSITORY");
  const rel = configured[choice];
  if (rel === ".") return { cwd: target.root, alias: choice };
  if (typeof rel !== "string") deny("INVALID_GIT_ROOT");
  const cwd = await existingPath(target.root, rel, "directory");
  return { cwd, alias: choice };
}
function sterileEnv() {
  const allow = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"];
  const result = { CI: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of allow) if (process.env[key]) result[key] = process.env[key];
  return result;
}
async function gitRead(cwd, args) {
  const { stdout } = await runFile("git", ["--no-optional-locks", "-C", cwd, ...args],
    { timeout: 8000, maxBuffer: 32 * 1024, windowsHide: true, env: sterileEnv() });
  return stdout.trimEnd();
}
function parsedWorktrees(output) {
  const entries = [];
  let entry = null;
  for (const line of (output + "\n\n").split(/\r?\n/)) {
    if (!line) {
      if (entry) entries.push(entry);
      entry = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (entry) deny("INVALID_GIT_WORKTREE_OUTPUT");
      entry = { path: line.slice(9), head: null, branch: null,
        locked: false, prunable: false };
    } else if (!entry) {
      deny("INVALID_GIT_WORKTREE_OUTPUT");
    } else if (line.startsWith("HEAD ")) entry.head = line.slice(5);
    else if (line.startsWith("branch ")) entry.branch = line.slice(7);
    else if (line.startsWith("locked")) entry.locked = true;
    else if (line.startsWith("prunable")) entry.prunable = true;
    else if (line !== "detached" && line !== "bare") deny("INVALID_GIT_WORKTREE_OUTPUT");
  }
  if (entries.length > 80 || entries.some(e =>
    !path.isAbsolute(e.path) || !/^[a-f0-9]{40}$/.test(e.head ?? ""))) {
    deny("INVALID_GIT_WORKTREE_OUTPUT");
  }
  return entries.map(e => ({ ...e, id: hash(Buffer.from(
    process.platform === "win32" ? path.resolve(e.path).toLowerCase() :
      path.resolve(e.path))).slice(0, 20) }));
}
async function registeredWorktrees(cwd) {
  return parsedWorktrees(await gitRead(cwd, ["worktree", "list", "--porcelain"]));
}
function containedIn(root, value) {
  const relative = path.relative(root, value);
  return relative === "" || (relative !== ".."
    && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
async function safeWorktreeRoot(root, entry) {
  if (!containedIn(root, entry.path) || entry.prunable) {
    deny("WORKTREE_OUTSIDE_FIXED_ROOT_OR_PRUNABLE");
  }
  const stat = await fs.lstat(entry.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || !comparePath(entry.path, await fs.realpath(entry.path))) {
    deny("WORKTREE_ROOT_REDIRECTED");
  }
}
async function journalPrecondition(target, args) {
  if (!/^[a-f0-9]{64}$/.test(args?.expected_journal_sha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(args?.expected_state_sha256 ?? "")) {
    deny("MISSING_EXACT_LEDGER_PRECONDITION");
  }
  const [journal, state] = await Promise.all([
    readFixedFile(target.journal), readFixedFile(target.state)
  ]);
  if (hash(journal) !== args.expected_journal_sha256
      || hash(state) !== args.expected_state_sha256) deny("LEDGER_PRECONDITION_CHANGED");
}
export function createCodingService(config) {
  return {
    async read_project_file(args) {
      if (config.enableCodingRead !== true) deny("CODING_READ_DISABLED");
      const target = await permittedFile(config, args, "read");
      const bytes = await readSource(target.file);
      return { project: args.project, path: args.path,
        sha256: hash(bytes), bytes: bytes.length, ...checkedWindow(args, bytes) };
    },
    async inspect_project_git(args) {
      if (config.enableCodingRead !== true) deny("CODING_READ_DISABLED");
      const target = await policyFor(config, args?.project);
      const { cwd, alias } = await gitDirectory(target, args?.repository);
      const top = await gitRead(cwd, ["rev-parse", "--show-toplevel"]);
      if (!comparePath(top, cwd)) deny("GIT_REPOSITORY_ROOT_MISMATCH");
      const [head, branch, status] = await Promise.all([
        gitRead(cwd, ["rev-parse", "HEAD"]),
        gitRead(cwd, ["branch", "--show-current"]),
        gitRead(cwd, ["status", "--porcelain=v1", "--untracked-files=no"])
      ]);
      if (Buffer.byteLength(status, "utf8") > MAX_RESPONSE_BYTES) {
        deny("GIT_STATUS_TOO_LARGE");
      }
      return { project: args.project, repository: alias, head, branch,
        trackedChanges: status, writerStatus: "UNKNOWN",
        note: "Git status does not prove ownership or authorize a commit." };
    },
    async inspect_project_worktrees(args) {
      if (config.enableCodingRead !== true) deny("CODING_READ_DISABLED");
      const target = await policyFor(config, args?.project);
      const { cwd, alias } = await gitDirectory(target, args?.repository);
      const top = await gitRead(cwd, ["rev-parse", "--show-toplevel"]);
      if (!comparePath(top, cwd)) deny("GIT_REPOSITORY_ROOT_MISMATCH");
      const registered = await registeredWorktrees(cwd);
      return { project: args.project, repository: alias,
        worktrees: registered.map(item => ({
          id: item.id, head: item.head, branch: item.branch,
          path: item.path, locked: item.locked, prunable: item.prunable,
          readable: containedIn(target.root, item.path) && !item.prunable
        })),
        note: "Git registration alone does not prove ownership, inactivity or safe cleanup." };
    },
    async read_project_worktree_file(args) {
      if (config.enableCodingRead !== true) deny("CODING_READ_DISABLED");
      const target = await policyFor(config, args?.project);
      const { cwd, alias } = await gitDirectory(target, args?.repository);
      const top = await gitRead(cwd, ["rev-parse", "--show-toplevel"]);
      if (!comparePath(top, cwd)) deny("GIT_REPOSITORY_ROOT_MISMATCH");
      if (typeof args?.worktree_id !== "string" || !/^[a-f0-9]{20}$/.test(args.worktree_id)) {
        deny("INVALID_WORKTREE_ID");
      }
      const registered = await registeredWorktrees(cwd);
      const selected = registered.find(item => item.id === args.worktree_id);
      if (!selected || selected.locked || selected.prunable) deny("WORKTREE_NOT_AVAILABLE");
      await safeWorktreeRoot(target.root, selected);
      const currentHead = await gitRead(selected.path, ["rev-parse", "HEAD"]);
      if (currentHead !== selected.head) deny("WORKTREE_CHANGED_DURING_INSPECTION");
      const filePath = args?.path;
      relativeName(filePath);
      const aliasPrefix = path.relative(target.root, cwd).split(path.sep).join("/");
      const allowPath = aliasPrefix ? aliasPrefix + "/" + filePath : filePath;
      if (!prefixesContain(target.policy.readPrefixes, allowPath)) deny("FILE_NOT_ALLOWLISTED");
      const pathname = await existingPath(selected.path, filePath, "file");
      const source = await readSource(pathname);
      return { project: args.project, repository: alias,
        worktree_id: selected.id, head: currentHead, path: filePath,
        sha256: hash(source), bytes: source.length, ...checkedWindow(args, source),
        note: "Read-only from a registered in-project worktree; not proof of writer ownership." };
    },
    async run_project_check(args) {
      if (config.enableProjectChecks !== true) deny("PROJECT_CHECKS_DISABLED");
      const target = await policyFor(config, args?.project);
      const checkId = args?.check_id;
      if (typeof checkId !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(checkId)
          || !Object.hasOwn(target.policy.checks ?? {}, checkId)) {
        deny("UNKNOWN_PROJECT_CHECK");
      }
      const check = target.policy.checks[checkId];
      if (typeof check.executable !== "string" || !path.isAbsolute(check.executable)
          || !Array.isArray(check.args) || check.args.length > 24
          || check.args.some(x => typeof x !== "string" || x.length > 512)
          || !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1000
          || check.timeoutMs > MAX_CHECK_MS) deny("INVALID_OPERATOR_CHECK");
      await journalPrecondition(target, args);
      const lockPath = path.join(target.shot, ".codexify-project-check.lock");
      let lock;
      try { lock = await fs.open(lockPath, "wx", 0o600); }
      catch (e) {
        if (e.code === "EEXIST") deny("PROJECT_CHECK_LOCK_PRESENT");
        throw e;
      }
      try {
        await journalPrecondition(target, args);
        const stdout = [];
        const stderr = [];
        let size = 0;
        const outputLimit = 2 * MAX_RESPONSE_BYTES;
        const result = await new Promise((resolve, reject) => {
          const child = spawn(check.executable, check.args, {
            cwd: target.root, env: sterileEnv(), shell: false,
            windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          let tooMuch = false;
          let timedOut = false;
          const collect = (list, chunk) => {
            size += chunk.length;
            if (size > outputLimit) { tooMuch = true; child.kill(); return; }
            list.push(chunk);
          };
          child.stdout.on("data", chunk => collect(stdout, chunk));
          child.stderr.on("data", chunk => collect(stderr, chunk));
          const timer = setTimeout(() => { timedOut = true; child.kill(); }, check.timeoutMs);
          child.once("error", err => { clearTimeout(timer); reject(err); });
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, tooMuch, timedOut });
          });
        });
        await journalPrecondition(target, args);
        return { project: args.project, check_id: checkId, exitCode: result.code,
          signal: result.signal, timedOut: result.timedOut,
          outputTruncated: result.tooMuch,
          stdout: Buffer.concat(stdout).toString("utf8").slice(-MAX_RESPONSE_BYTES),
          stderr: Buffer.concat(stderr).toString("utf8").slice(-MAX_RESPONSE_BYTES),
          note: "Exact project check only. No claim of cross-process writer exclusivity." };
      } finally {
        try { await lock.close(); } finally { await fs.unlink(lockPath); }
      }
    },
    async apply_project_edit(args) {
      if (config.enableCodingWrites !== true) deny("CODING_WRITES_DISABLED");
      const target = await permittedFile(config, args, "write");
      if (!/^[a-f0-9]{64}$/.test(args?.expected_sha256 ?? "")
          || typeof args.find !== "string" || args.find.length < 1 || args.find.length > 8192
          || typeof args.replacement !== "string" || args.replacement.length > 8192
          || args.replacement.includes("\0")) deny("INVALID_EDIT_REQUEST");
      await journalPrecondition(target, args);
      const lockPath = path.join(target.shot, ".codexify-source-edit.lock");
      let lock;
      try { lock = await fs.open(lockPath, "wx", 0o600); }
      catch (e) {
        if (e.code === "EEXIST") deny("SOURCE_EDIT_LOCK_PRESENT");
        throw e;
      }
      let tempFile = null;
      try {
        const before = await readSource(target.file);
        if (hash(before) !== args.expected_sha256) deny("SOURCE_PRECONDITION_CHANGED");
        const text = before.toString("utf8");
        const first = text.indexOf(args.find);
        if (first < 0 || text.indexOf(args.find, first + args.find.length) >= 0) {
          deny("EDIT_CONTEXT_NOT_UNIQUE");
        }
        const updated = Buffer.from(text.slice(0, first) + args.replacement
          + text.slice(first + args.find.length), "utf8");
        if (updated.length > MAX_FILE_BYTES) deny("SOURCE_TOO_LARGE_AFTER_EDIT");
        await journalPrecondition(target, args);
        if (hash(await readSource(target.file)) !== args.expected_sha256) {
          deny("SOURCE_CHANGED_DURING_EDIT");
        }
        tempFile = target.file + ".codexify-" + randomBytes(8).toString("hex") + ".tmp";
        const f = await fs.open(tempFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        try { await f.writeFile(updated); await f.sync(); } finally { await f.close(); }
        await journalPrecondition(target, args);
        if (hash(await readSource(target.file)) !== args.expected_sha256) {
          deny("SOURCE_CHANGED_DURING_EDIT");
        }
        await fs.rename(tempFile, target.file);
        tempFile = null;
        const actual = await readSource(target.file);
        if (hash(actual) !== hash(updated)) deny("EDIT_POSTCONDITION_AMBIGUOUS");
        return { project: args.project, path: args.path,
          previousSha256: args.expected_sha256, sha256: hash(actual),
          bytes: actual.length, status: "UPDATED",
          note: "Only this sidecar's lock is coordinated; external writer exclusivity remains unverified." };
      } finally {
        if (tempFile) await fs.unlink(tempFile).catch(() => {});
        try { await lock.close(); } finally { await fs.unlink(lockPath); }
      }
    }
  };
}
