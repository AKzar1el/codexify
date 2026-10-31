# Scoped Revenue Shot GSC canary

Status: prepared and tested; not installed.

This pilot exposes three narrowly scoped MCP operations through the existing revenue_shot_preflight server:

- preflight_worktree_action: read only; verifies registered, isolated GSC worktree, exact Git HEAD and source/journal/state hashes.
- apply_scoped_worktree_edit: host-approved write action for exactly scripts/glama-start.mjs in a revenue-shot/ worktree, durable intent/result receipts, no replay.
- run_scoped_worktree_check: host-approved bounded launcher regression only after verified edit.
- The global canonical journal and coding write/check switches remain false. No push, merge, release, spending, account mutation, outreach, or task schedule change.

The operator must explicitly approve an installation outside this bound ChatGPT workspace. The installer refuses any baseline drift, retains backups, and will not install unless PowerShell is interactive. It never alters the canonical GSC journal or any historical unresolved run.

Read-only verification:

    node scripts/prepare-revenue-scoped-gsc.mjs --check
    node --test scripts/prepare-revenue-scoped-gsc.test.mjs

Owner activation: In Windows PowerShell opened as Administrator on the PC:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\lol\codexify-njs-repair-20261031\scripts\activate-revenue-scoped-gsc.ps1"

The activation asks for an exact typed approval phrase, stages and hash-checks changes, restarts only the existing Codexify task, checks HTTP health, and rolls back if startup fails. Live tool exposure and host confirmation still require separate verification after the service reconnects. If the connector does not expose the new tools automatically, refresh the existing God v5 tool catalog through its normal controls.

Neither a sidecar lock nor a Git worktree alone proves global writer exclusivity. Keep the original unknown historical run endings as UNKNOWN; never fabricate terminals or replay uncertain effects. This canary does not override independent ChatGPT host action denials.

Never use an alternate shell or connector to circumvent the current God v5 project binding. Switch workspaces normally for further local development.
