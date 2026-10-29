// Standalone MCP stdio bridge. Production Codexify requires no Rust changes.
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createRevenueService, loadRevenueConfig } from "./ledger.mjs";

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
      "Inspect only this service's journal lock. Never assert that unrelated writers are absent.",
      { project }, ["project"], readOnly),
    tool("read_project_policy",
      "Read a bounded portion of one fixed policy/state document. No arbitrary path access.",
      { project, document: { type: "string",
        enum: ["master_plan", "current_state", "agents_override"] },
        offset: { type: "integer", minimum: 0, maximum: 1000000 },
        limit: { type: "integer", minimum: 1, maximum: 180 } },
      ["project", "document"], readOnly),
    tool("get_run_ledger_status",
      "Return immutable SHA256 preconditions, bounded journal tail and textual counters. Does not prove predecessor validity or writer absence.",
      { project }, ["project"], readOnly)
  ];
  if (config.enableKernelAttestation === true) {
    const kernelProjects = Object.keys(config.kernelFiles ?? {})
      .filter(id => Object.hasOwn(config.projects, id)).sort();
    if (kernelProjects.length) {
      list.push(tool("read_original_kernel",
        "Read an explicitly configured, SHA256-pinned original task kernel in bounded pages. Fixed project IDs only; never takes a path. Owner authorization is required to enable this tool.",
        { project: { type: "string", enum: kernelProjects },
          offset: { type: "integer", minimum: 0, maximum: 1000000 },
          limit: { type: "integer", minimum: 1, maximum: 4000 } },
        ["project"], readOnly));
    }
  }
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
  return list;
}
export function makeHandler(config) {
  const service = createRevenueService(config);
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
      serverInfo: { name: "revenue-shot-scoped", version: "0.1.0" } };
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
