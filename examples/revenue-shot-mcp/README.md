# Revenue Shot: optional narrow MCP tools

This is an **opt-in example** for exposing fixed-shape project inspections through Codexify's **existing `direct` bridge**. It does not modify Codexify's Rust core, production runner, user schedules, or project master plans. Node.js 22 or later is required; the example has no npm dependencies.

## Configure (read-only first)

Copy `config.example.json` to a private location, edit the **absolute, exact** project roots, and leave `enableWrites: false`. Never commit the local configuration or secrets. Configure an **explicit** Codexify MCP upstream named `revenue_shot`:

```json
{
  "mcpServers": {
    "revenue_shot": {
      "command": "node",
      "args": ["C:/path/to/codexify/examples/revenue-shot-mcp/server.mjs"],
      "env": { "REVENUE_SHOT_PROJECTS_FILE": "C:/private/revenue-projects.json" },
      "mode": "direct",
      "tools": ["inspect_project_writer", "read_project_policy", "get_run_ledger_status"]
    }
  }
}
```

The tool names become `revenue_shot__inspect_project_writer`, `revenue_shot__read_project_policy`, and `revenue_shot__get_run_ledger_status`. Missing write permission is intentional: `append_run_record` is not advertised when disabled.

`read_project_policy` accepts only fixed project IDs and a fixed document enum. Pages return whole lines and the SHA-256 of the unchanged source file. Continue using `nextOffset` until `truncated` is false; do not assume that a large 180-line request fits the 16 KB response budget. A single oversized line is rejected rather than silently dropped. This interface improves tool-risk separation; it does not authorize overriding a host denial or relaxing the project's mandatory policy and owner checks.

## Write path (migration gated)

`append_run_record` is **disabled by default** and must remain disabled in production until the current Revenue Shot writers have migrated to the same lock protocol. It requires the exact current state/journal SHA-256 digests, a verified predecessor run key, and one bounded record containing an exact `RUN_KEY: ...` line. It appends rather than rewrites the journal, rejects stale preconditions, and recognizes exact-tail duplicate submissions. Its safety annotations remain conservative: this is a write, potentially irreversible, not safe to automatically retry after an ambiguous failure.

**Important:** the lock serializes only calls that use this sidecar. Existing PowerShell/manual/executor journal writes do **not** honor the lock. Thus it cannot currently prove global atomic compare-and-append under mixed writers. The tool is a migration candidate, not a replacement for existing writer ownership, predecessor verification, action accounting, fsync/readback, protected Git checks, or project-specific master-plan rules. No live file should be appended merely because this tool is available.

`inspect_project_writer` reports the sidecar lock only and returns `writerStatus: UNKNOWN`; absence of its lock is **not** proof of no project writer. `get_run_ledger_status` provides hashes and textual counters, not semantic proof that every run was closed correctly. Use existing authenticated ownership verification for scheduled runs.

## Tests

```powershell
cd examples/revenue-shot-mcp
npm test
```

Tests create **temporary synthetic** `.revenue-shot` fixtures, cover read-only schemas, write-disabled behavior, stale hashes, duplicate requests, cross-process lock contention, symlink redirection, and a real stdio MCP handshake. They do not touch production journals.

For an optional read-only smoke test of your configured projects, set the absolute `REVENUE_SHOT_PROJECTS_FILE` path and run `node smoke-readonly.mjs`. This script forcibly disables writes even if the private config enables them. It prints only per-project read success, hashes, byte counts and the explicitly unverified writer status, not journal contents.

Before a production rollout, perform isolated MCP Inspector verification (including a realistic Codexify direct-mode startup), validate legitimate and unauthorized requests, prove interoperability with legacy writer procedures, and compare scheduled-run reliability without changing or pausing the seven existing automations.
