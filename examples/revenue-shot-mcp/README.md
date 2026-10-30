# Revenue Shot: optional narrow MCP tools

This is an **opt-in example** for exposing fixed-shape project inspections and coding operations through Codexify's **existing `direct` bridge**. A single Codexify process and OpenAI tunnel can serve all six configured projects; the lightweight Node sidecar does not create six Codexify instances. It does not modify Codexify's Rust core, production runner, user schedules, or project master plans. Node.js 22 or later is required; the example has no npm dependencies.

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

## Native direct coding surface (separately opt-in)

The same sidecar can now advertise seven additional *individually named* MCP tools, alongside four fixed-policy/ledger tools. None is a generic `n/js` dispatcher, model-selected shell command, arbitrary filesystem path or Git refspec:

| Tool | Required config | Capability |
| --- | --- | --- |
| `read_project_file` | `enableCodingRead: true` | Read complete bounded lines from operator-allowlisted UTF-8 source files, with SHA-256 and pagination |
| `inspect_project_git` | `enableCodingRead: true` | Read a configured Git repository alias, HEAD, branch and tracked status with optional Git locks disabled |
| `inspect_project_worktrees` | `enableCodingRead: true` | List Git-registered worktrees without changing, pruning or claiming ownership |
| `read_project_worktree_file` | `enableCodingRead: true` | Read a bounded source file in a registered in-root worktree with HEAD and symlink verification |
| `read_project_journal` | Always available | Read bounded canonical journal lines backward with stable SHA-256 and exact page boundaries |
| `run_project_check` | `enableProjectChecks: true` | Run one operator-fixed executable/argument tuple (no shell), bounded to 24 seconds and exact journal/state hashes |
| `apply_project_edit` | `enableCodingWrites: true` | Replace one uniquely matching source span after exact source/journal/state digest checks, with atomic file replacement |

Configure `coding.<project>.readPrefixes` and `writePrefixes` using explicit project-relative file paths or directory prefixes ending in `/`. All hidden paths, traversal, symbolic links, oversized/binary/non-UTF8 sources, and unconfigured prefixes are denied. `gitRoots` maps short aliases to existing project-relative Git directories (e.g. for GodPrompt, `primary: god-prompt` and `companion: god-prompt-mcp`). Project roots still come exclusively from the private fixed `projects` mapping. All three new capability flags **default to false**, so deploying these files without operator authorization does not silently widen the production connector.

For operator-approved tests, `coding.<project>.checks.<check_id>` must contain an absolute `executable`, a fixed string array `args`, and integer `timeoutMs` between 1000 and 24000. The model supplies **only** the fixed project ID, check ID and current journal/state SHA-256 digests. The check runs without a shell and with a small environment allowlist. It can still run arbitrary project code, create files or access a network; its MCP annotations **do not** mark it read-only. Do not enable it for an untrusted project or an unproven concurrent writer.

Code edits remain **disabled for scheduled Revenue Shot workers** until the existing nonparticipating writers are migrated to an independently verified ownership protocol. A local sidecar lock alone cannot guarantee exclusivity, and SHA-256 checks do not eliminate a final external-writer race. No release, Git push, browser submission or scheduler mutation is granted by these tools. Never retry a host-denied action through a differently named tool.

Roll out read-only first: stage the reviewed files in a separate directory, enable only `enableCodingRead` in its private project map, and restart the **existing single Codexify service** only after all active Revenue Shot workers are safely closed. The direct bridge exposes the new tool descriptors on startup. Recheck `tools/list` and run a read-only canary from a genuine scheduled worker before enabling other operations or rewriting worker prompts. Preserve the existing six project run journals, seven automations and original consent/Git/CI gates.

For the existing six-project Windows fleet, `activate-readonly.mjs` stages the already-reviewed files in a **separate folder** at `~/.codexify/revenue-shot-direct-v03/`, leaving `~/.codexify/revenue-shot-readonly/` untouched. It validates the exact six configured project keys and original `enableWrites: false` flag. The `activate` step backs up the original private Codexify configuration and changes only the existing `revenue_shot_preflight` bridge's one script path, one private config path, and its allowlist (three old tools plus the two read-only coding tools); there is still only one Codexify process, one tunnel and one direct upstream.

```powershell
# From examples/revenue-shot-mcp:
node activate-readonly.mjs stage
$env:REVENUE_SHOT_PROJECTS_FILE = "$HOME\.codexify\revenue-shot-direct-v03\projects.json"
node smoke-coding-readonly.mjs
node activate-readonly.mjs activate

# ONLY at a separately verified safe fleet-idle boundary:
codexify service restart
# Then refresh the existing God v5 connector/action catalogue and verify
# all five direct tools before changing any worker prompt.

# Exact rollback, only if no other config changes happened meanwhile:
node activate-readonly.mjs rollback
# Then restart again at a safe fleet-idle boundary.
```

The activation script never restarts services or edits scheduled tasks. It fails closed on an unexpected bridge/configuration, refuses to overwrite a different staging payload, and creates a byte-for-byte private configuration backup. It does not imply OpenAI will approve every call; native, correctly annotated tools are not a permission bypass. Do not silently enable `enableProjectChecks` or `enableCodingWrites` during this read-only rollout.

## v0.4 all-six native read migration

Use `activate-native-v04.mjs stage` and `activate-native-v04.mjs activate` to move from the already-installed v0.3 directory to the separate `~/.codexify/revenue-shot-direct-v04/` sidecar, **without changing the single Codexify tunnel, project roots, or seven schedules**. This enables eight total *read-only* tools (the previous five plus journal and two worktree tools). It leaves all direct editing, test execution and journal-appending capabilities disabled. A byte-for-byte pre-v0.4 config backup is retained in the staged folder. Revert with `activate-native-v04.mjs rollback` if necessary, followed by a service restart at a verified idle boundary.

Run the synthetic tests and `smoke-coding-readonly.mjs` against the existing six-project private map **before** activation. The smoke validates source reads, Git HEAD and registered worktree inventory for all six projects, plus one verified canonical worktree-file read. It does not inspect live journal text or retry previously host-denied project operations. A new ChatGPT tool refresh is required after a safe Codexify service restart to materialize the additional direct methods.

The six scheduled Revenue Shot prompts must be migrated together using a clear routing override that supersedes *only* their old `n/js` read/Git-preflight requirement. The original product, saved-kernel, finance, host-denial, effect-deduplication, writer-ownership, Git and protected-CI controls remain binding. **This is not a full autonomous write/test migration:** a formerly denied operation must not be rerouted through the new tool names; write/test/journal tools remain disabled until participating writer ownership, project-specific tests, original authorization and correct host confirmation are independently qualified. If those prerequisites are absent, report the concrete remaining blocker rather than fabricate completion.
