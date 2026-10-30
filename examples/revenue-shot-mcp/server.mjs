// Standalone MCP stdio bridge. Production Codexify requires no Rust changes.
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createRevenueService, loadRevenueConfig } from "./ledger.mjs";
import { createCodingService } from "./coding.mjs";

function tool(name, description, properties, required, annotations) {
  return { name, title: name.replaceAll("_", " "),
    description, inputSchema: { type: "object", properties,
      required, additionalProperties: false }, annotations };
}
function definitions(config) {
  const projects = Object.keys(config.projects).sort();
  const project = { type: "string", enum: projects,
    description: "Configured fixed project identifier, never a filesystem path." };
  const readOnly = { readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false };
  const writer = { readOnlyHint: false, destructiveHint: true,
    idempotentHint: false, openWorldHint: false };
  const list = [
    tool("inspect_project_writer",
      "Report fixed canonical project root and sidecar-only journal lock; never certify unrelated writers.",
      { project }, ["project"], readOnly),
    tool("read_project_policy",
      "Read a bounded portion of one fixed policy/state document. No arbitrary path access.",
      { project, document: { type: "string",
        enum: ["master_plan", "current_state", "agents_override"] },
        offset: { type: "integer", minimum: 0, maximum: 1000000 },
        limit: { type: "integer", minimum: 1, maximum: 180 } },
      ["project", "document"], readOnly),
    tool("get_run_ledger_status",
      "Return fixed-root digests and optional exact RUN_KEY record counts without journal text. Does not prove writer exclusivity or original completion.",
      { project, run_key: { type: "string", minLength: 8, maxLength: 160,
        pattern: "^[A-Za-z0-9_.:+-]{8,160}$" } }, ["project"], readOnly)
  ];
  if (config.enableWrites === true) {
    list.push(tool("append_run_record",
      "Append one bounded journal record with exact state/journal hashes and predecessor evidence. Not safe against legacy nonparticipating writers; do not automatically retry ambiguous failures.",
      { project,
        run_key: { type: "string", minLength: 8, maxLength: 160 },
        predecessor_run_key: { type: "string", minLength: 8, maxLength: 160 },
        expected_journal_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        record: { type: "string", minLength: 20, maxLength: 16384 } },
      ["project", "run_key", "predecessor_run_key",
        "expected_journal_sha256", "expected_state_sha256", "record"], writer));
  }
  const codingProjects = Object.keys(config.coding ?? {})
    .filter(name => projects.includes(name)).sort();
  if (codingProjects.length > 0) {
    const codeProject = { type: "string", enum: codingProjects,
      description: "Configured fixed project identifier; never a path." };
    const file = { type: "string", minLength: 1, maxLength: 260,
      description: "Project-relative, operator-allowlisted code file." };
    const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
    const ledger = { expected_journal_sha256: sha, expected_state_sha256: sha };
    if (config.enableCodingRead === true) {
      list.push(tool("read_project_file",
        "Read a bounded, allowlisted source file from one fixed project. No hidden files or arbitrary paths.",
        { project: codeProject, path: file,
          offset: { type: "integer", minimum: 0, maximum: 1000000 },
          limit: { type: "integer", minimum: 1, maximum: 180 } },
        ["project", "path"], readOnly));
      list.push(tool("inspect_project_git",
        "Read current Git HEAD, branch and tracked status of an operator-configured project repository. Does not prove writer ownership.",
        { project: codeProject, repository: { type: "string",
          description: "Fixed repository alias, not a path or refspec." } },
        ["project"], readOnly));
    }
    if (config.enableProjectChecks === true) {
      const checkProjects = codingProjects.filter(p =>
        Object.keys(config.coding[p]?.checks ?? {}).length > 0);
      if (checkProjects.length) {
        list.push(tool("run_project_check",
          "Run one operator-allowlisted, bounded project check. May change local files or contact external systems; requires exact ledger preconditions. Never assumes exclusive ownership.",
          { project: { type: "string", enum: checkProjects },
            check_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,39}$" },
            ...ledger }, ["project", "check_id",
              "expected_journal_sha256", "expected_state_sha256"],
          { readOnlyHint: false, destructiveHint: true,
            idempotentHint: false, openWorldHint: true }));
      }
    }
    if (config.enableCodingWrites === true) {
      const editProjects = codingProjects.filter(p =>
        Array.isArray(config.coding[p]?.writePrefixes)
        && config.coding[p].writePrefixes.length > 0);
      if (editProjects.length) {
        list.push(tool("apply_project_edit",
          "Replace exactly one existing source span, guarded by source and journal/state SHA256 preconditions. May overwrite code; not safe to blindly retry or use without independent owner verification.",
          { project: { type: "string", enum: editProjects }, path: file,
            expected_sha256: sha, ...ledger,
            find: { type: "string", minLength: 1, maxLength: 8192 },
            replacement: { type: "string", maxLength: 8192 } },
          ["project", "path", "expected_sha256",
            "expected_journal_sha256", "expected_state_sha256", "find", "replacement"],
          writer));
      }
    }
  }
  return list;
}
export function makeHandler(config) {
  const service = { ...createRevenueService(config), ...createCodingService(config) };
  const tools = definitions(config);
  return async function handle(request) {
    if (!request || request.jsonrpc !== "2.0" || Array.isArray(request)) {
      return { jsonrpc: "2.0", id: request?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC request" } };
    }
    if (!Object.hasOwn(request, "id")) return null;
    const method = request.method;
    let result;
    if (method === "initialize") {
      const preferred = request.params?.protocolVersion;
      result = { protocolVersion: ["2025-06-18", "2025-11-25", "2026-07-28"].includes(preferred)
        ? preferred : "2025-11-25", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "revenue-shot-scoped", version: "0.3.0" } };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools };
    } else if (method === "tools/call") {
      const name = request.params?.name;
      if (!tools.some(def => def.name === name)) {
        return { jsonrpc: "2.0", id: request.id,
          error: { code: -32602, message: "Unknown or disabled tool" } };
      }
      const args = request.params?.arguments;
      try {
        const data = await service[name](args);
        result = { content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data, isError: false };
      } catch (error) {
        result = { content: [{ type: "text",
          text: error?.code || "OPERATION_FAILED" }], isError: true };
      }
    } else {
      return { jsonrpc: "2.0", id: request.id,
        error: { code: -32601, message: "Method not found" } };
    }
    return { jsonrpc: "2.0", id: request.id, result };
  };
}
async function main() {
  const config = await loadRevenueConfig(process.env.REVENUE_SHOT_PROJECTS_FILE);
  const handle = makeHandler(config);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null,
        error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    try {
      const response = await handle(request);
      if (response !== null) process.stdout.write(JSON.stringify(response) + "\n");
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0",
        id: request?.id ?? null, error: { code: -32603, message: "Internal error" } }) + "\n");
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error?.code || "CONFIGURATION_FAILURE"); process.exitCode = 1; });
}
