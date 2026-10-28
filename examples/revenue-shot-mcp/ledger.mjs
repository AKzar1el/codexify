// Opt-in, project-scoped Revenue Shot operations. No shell or arbitrary paths.
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DOCUMENTS = Object.freeze({
  master_plan: ".revenue-shot/MASTER_PLAN.md",
  current_state: ".revenue-shot/CURRENT_STATE.md",
  agents_override: "AGENTS.override.md",
  run_journal: ".revenue-shot/RUN_JOURNAL.md"
});
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;

function failure(message) {
  const error = new Error(message);
  error.code = message;
  return error;
}
function normalized(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function validKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9_.:+-]{8,160}$/.test(key);
}
function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
async function fixedRegularFile(expected) {
  const stat = await fs.lstat(expected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOCUMENT_BYTES) {
    throw failure("UNSAFE_OR_OVERSIZED_FILE");
  }
  const actual = await fs.realpath(expected);
  if (normalized(expected) !== normalized(actual)) {
    throw failure("FILE_REDIRECTED");
  }
  return { actual, stat };
}
async function readFixedFile(expected) {
  const { actual } = await fixedRegularFile(expected);
  return fs.readFile(actual);
}
async function resolveProject(config, project) {
  if (!config || !config.projects || typeof project !== "string"
      || !Object.hasOwn(config.projects, project)
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(project)) {
    throw failure("UNKNOWN_PROJECT");
  }
  const expected = config.projects[project];
  if (typeof expected !== "string" || !path.isAbsolute(expected)) {
    throw failure("PROJECT_ROOT_NOT_ABSOLUTE");
  }
  const actual = await fs.realpath(expected);
  if (normalized(actual) !== normalized(expected)) {
    throw failure("PROJECT_ROOT_REDIRECTED");
  }
  const shot = path.join(actual, ".revenue-shot");
  const { stat } = await fs.lstat(shot).then(stat => ({ stat }));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure("UNSAFE_REVENUE_DIRECTORY");
  }
  if (normalized(await fs.realpath(shot)) !== normalized(shot)) {
    throw failure("REVENUE_DIRECTORY_REDIRECTED");
  }
  return { root: actual, shot, journal: path.join(shot, "RUN_JOURNAL.md"),
    state: path.join(shot, "CURRENT_STATE.md") };
}
function validatedRecord(args) {
  if (!validKey(args.run_key) || !validKey(args.predecessor_run_key)
      || !validDigest(args.expected_journal_sha256)
      || !validDigest(args.expected_state_sha256)) {
    throw failure("INVALID_RECORD_CONDITION");
  }
  if (typeof args.record !== "string" || !args.record.endsWith("\n")
      || args.record.includes("\0")
      || Buffer.byteLength(args.record, "utf8") > MAX_RECORD_BYTES
      || Buffer.byteLength(args.record, "utf8") < 20) {
    throw failure("INVALID_RECORD_CONTENT");
  }
  if (!args.record.split(/\r?\n/).includes("RUN_KEY: " + args.run_key)) {
    throw failure("RECORD_RUN_KEY_MISMATCH");
  }
  return args.record;
}
function markers(text) {
  return {
    runStartMarkers: (text.match(/(?:^|\n)RUN_START_V3(?:\s|:|$)/g) || []).length,
    actionIntentMarkers: (text.match(/(?:^|\n)ACTION_INTENT_V3(?:\s|:|$)/g) || []).length,
    actionResultMarkers: (text.match(/(?:^|\n)ACTION_RESULT_V3(?:\s|:|$)/g) || []).length
  };
}
export function createRevenueService(config) {
  if (!config || typeof config !== "object") throw failure("INVALID_CONFIGURATION");
  const writesEnabled = config.enableWrites === true;
  return {
    async read_project_policy(args) {
      const project = await resolveProject(config, args?.project);
      const doc = args?.document;
      if (!["master_plan", "current_state", "agents_override"].includes(doc)) {
        throw failure("UNSUPPORTED_POLICY_DOCUMENT");
      }
      const contents = await readFixedFile(path.join(project.root, DOCUMENTS[doc]));
      const offset = args.offset === undefined ? 0 : args.offset;
      const limit = args.limit === undefined ? 100 : args.limit;
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000
          || !Number.isInteger(limit) || limit < 1 || limit > 180) {
        throw failure("INVALID_READ_WINDOW");
      }
      const lines = contents.toString("utf8").split(/\r?\n/);
      // Return complete lines only. A blind character slice can silently
      // discard policy text while claiming the next line offset is safe.
      const returned = [];
      let bytes = 0;
      for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf8") + (returned.length ? 1 : 0);
        if (lineBytes > 16000 && returned.length === 0) {
          throw failure("POLICY_LINE_TOO_LARGE");
        }
        if (bytes + lineBytes > 16000) break;
        returned.push(line);
        bytes += lineBytes;
      }
      const nextOffset = offset + returned.length;
      const value = returned.join("\n");
      return { project: args.project, document: doc, offset, lines: lines.length,
        returnedLines: returned.length, nextOffset, sha256: digest(contents),
        content: value, truncated: nextOffset < lines.length };
    },
    async get_run_ledger_status(args) {
      const project = await resolveProject(config, args?.project);
      const [journal, state] = await Promise.all([
        readFixedFile(project.journal), readFixedFile(project.state)
      ]);
      const text = journal.toString("utf8");
      return { project: args.project, journalSha256: digest(journal),
        stateSha256: digest(state), journalBytes: journal.length, stateBytes: state.length,
        ...markers(text), tail: text.split(/\r?\n/).slice(-8).join("\n").slice(-1800),
        note: "Record counts are textual hints; writer identity and predecessor terminal state are NOT proven." };
    },
    async inspect_project_writer(args) {
      const project = await resolveProject(config, args?.project);
      const lock = path.join(project.shot, ".codexify-journal-append.lock");
      let lockPresent = false;
      let ageSeconds = null;
      try {
        const stat = await fs.lstat(lock);
        lockPresent = true;
        ageSeconds = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { project: args.project, sidecarLockPresent: lockPresent, lockAgeSeconds: ageSeconds,
        externalWriterVerified: false, writerStatus: "UNKNOWN",
        note: "Absence of the sidecar lock does not prove that another worker is absent." };
    },
    async append_run_record(args) {
      if (!writesEnabled) throw failure("JOURNAL_WRITES_DISABLED");
      const project = await resolveProject(config, args?.project);
      const record = validatedRecord(args);
      const lockPath = path.join(project.shot, ".codexify-journal-append.lock");
      let lock;
      try {
        lock = await fs.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") throw failure("WRITER_LOCK_BUSY_OR_STALE");
        throw error;
      }
      try {
        await lock.writeFile(JSON.stringify({ project: args.project,
          runKey: args.run_key, pid: process.pid }) + "\n", "utf8");
        await lock.sync();
        const [journal, state] = await Promise.all([
          readFixedFile(project.journal), readFixedFile(project.state)
        ]);
        const oldJournal = journal.toString("utf8");
        // A verified exact-tail replay has no additional effect.
        if (oldJournal.endsWith(record)) {
          return { status: "ALREADY_APPLIED", project: args.project,
            sha256: digest(journal), appendedBytes: 0 };
        }
        if (digest(journal) !== args.expected_journal_sha256
            || digest(state) !== args.expected_state_sha256) {
          throw failure("PRECONDITION_DIGEST_MISMATCH");
        }
        if (!oldJournal.includes("RUN_KEY: " + args.predecessor_run_key)) {
          throw failure("PREDECESSOR_NOT_FOUND");
        }
        // This lock coordinates sidecar callers only; nonparticipating writers
        // must migrate before a live rollout can claim global atomicity.
        const prefix = journal.length && journal[journal.length - 1] !== 10 ? "\n" : "";
        const data = Buffer.from(prefix + record, "utf8");
        let target;
        try {
          target = await fs.open(project.journal, fsConstants.O_WRONLY | fsConstants.O_APPEND);
          const result = await target.write(data);
          if (result.bytesWritten !== data.length) throw failure("PARTIAL_APPEND_AMBIGUOUS");
          await target.sync();
        } finally {
          if (target) await target.close();
        }
        const current = await readFixedFile(project.journal);
        if (!current.toString("utf8").endsWith(record)) {
          throw failure("POST_APPEND_AMBIGUOUS");
        }
        return { status: "APPENDED", project: args.project,
          sha256: digest(current), appendedBytes: data.length };
      } finally {
        try { await lock.close(); } finally { await fs.unlink(lockPath); }
      }
    }
  };
}
export async function loadRevenueConfig(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) {
    throw failure("CONFIG_PATH_REQUIRED");
  }
  const source = await fs.readFile(filename, "utf8");
  const value = JSON.parse(source.replace(/^\uFEFF/, ""));
  if (!value || !value.projects || Array.isArray(value.projects)
      || typeof value.projects !== "object"
      || Object.keys(value.projects).length === 0
      || Object.keys(value.projects).length > 12
      || Object.values(value.projects).some(root => typeof root !== "string")) {
    throw failure("INVALID_PROJECT_MAP");
  }
  return value;
}
