# Six-project Revenue Shot scoped coding lanes

Status: prepared, tested and pushed in the existing Codexify repair checkout. **Not installed in the live sidecar.**

Existing God v5 tunnel, seven recurring schedules and the patched Codexify binary stay untouched. No canonical journal/state records are reset or truncated; historical start-only cases remain marked UNKNOWN.

## What the fleet controller does

Once the owner explicitly activates the updated MCP sidecar and enables its write actions in ChatGPT Workspace Apps, each project can plan and create a *single* new clean, isolated local Git worktree from an exact, already-verified local main commit:

| Project | Git repo alias | Allowed existing source paths | Bounded check |
| --- | --- | --- | --- |
| GEO | root | src/ | git diff --check |
| GodPrompt | primary or companion | build.py, bench/, src/ | git diff --check |
| GSC | root | scripts/glama-start.mjs, src/ | git diff --check or existing launcher test |
| NoFax | root | src/ | git diff --check |
| TrendPulse | root | src/ | git diff --check |
| Web Validator | root | src/ | git diff --check |

The fixed branch names are revenue-shot/fleet-v1-PROJECT-REPOSITORY. Repositories and paths are configured by the operator, never supplied as arbitrary agent roots. Existing source files only; no unapproved new files. Local main is pinned by an exact SHA, and the canonical journal/state SHA are checked but not changed.

Tools: plan_scoped_worktree (read), create_scoped_worktree (write), preflight_worktree_action (read), apply_scoped_worktree_edit (write), run_scoped_worktree_check (write). Each write tool is host-approved, source-hash guarded and uses a durable intent/result receipt. Ambiguous or interrupted operations fail closed without blind replay. Creating a worktree disables Git hooks and submodule traversal, never performs remote fetch/push or automatic cleaning.

The source-diff check is NOT a replacement for the full existing project test suites. Protected tests, pushes, merges, releases, deployments, payments, outreach, account changes and unapproved historical ledger writes remain outside these capabilities.

## Local read-only validation

    node scripts/prepare-revenue-fleet.mjs --check
    node --test scripts/prepare-revenue-fleet.test.mjs scripts/fleet-scoped-worktree-actions.test.mjs

The test suite includes seven real-repository read-only plans (the GodPrompt suite has two Git repositories), disposable Git worktree creation, a verified fixture edit and diff check, refusal of stale SHA or wrong repository binding, and noninteractive deployment denial.

## Owner-only activation

Open Windows PowerShell **as Administrator** outside the God v5 tunnel. First ensure no Revenue Shot worker is in the middle of an authorized action, then run:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\lol\codexify-njs-repair-20261031\scripts\activate-revenue-fleet.ps1"

The script requires a typed approval phrase, checks fixed old/new hashes, writes verified backups, installs the modules and updates the MCP sidecar, restarts only the existing Codexify Windows task, verifies local HTTP 200 and tool list, and restores the prior GSC-only sidecar if startup fails. It does not create worktrees or alter scheduled automation tasks.

After the installer reports FLEET_INSTALLED_HTTP200_AND_TOOL_LIST_VERIFIED, an administrator must refresh the God v5 custom app's tools/actions in ChatGPT workspace settings, review newly added and changed write actions, explicitly enable approved actions, and start a new chat with the correct project selected. Reconnecting the tunnel alone does not update an approved, frozen tool snapshot.

**Do not enable generic global journaling, coding or test booleans.** The old sidecar remains read-only and unrelated historical ledger issues are preserved. Activating these new tools does not confer unrelated writer ownership or waive ChatGPT host approvals.

## Recovery

Backup receipts are in the existing local maintenance folder, named fleet-scoped-backup-*. The extra fleet helper files are harmless if the old server/config are restored; no old binaries or journals are deleted. To investigate an interrupted bootstrap, inspect its exact durable intent and Git worktree registration; never auto-repeat a pending operation.
