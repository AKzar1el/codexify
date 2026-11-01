# Revenue Shot Fleet v3 — fresh remote-main worktrees

Status: staged and tested; NOT installed until elevated owner activation. Six developer-worker prompts were updated with recurring isolated-lane permission and all original hourly schedules and enabled states preserved. Overwatch remains unchanged. Prompts refuse live edits until the host exposes the v3 mode and exact worktree.

## Remote baseline refresh, November 1, 2026

A narrowly scoped git fetch updated only refs/remotes/origin/main for seven local repositories, with no tags, prune, submodules, merge or reset. Checked-out local main, branches, tracked modifications, and older worktrees were unchanged.

| Repository | Local main | Fetched origin/main | Ahead |
| --- | --- | --- | ---: |
| GEO | 5e20e150 | c539916f | 14 |
| GodPrompt primary | d2b85861 | cff32c47 | 27 |
| GodPrompt companion | 0f7a9ea0 | 0f7a9ea0 | 0 |
| GSC | a247d878 | a3accc7c | 7 |
| NoFax | c6375da3 | 07e45ccc | 17 |
| TrendPulse | 5291d005 | e7b3240 | 9 |
| Web Validator | 7bd2c1ae | da3213d8 | 31 |

GEO and TrendPulse have previous tracked changes. The old NoFax external v1 worktree contains the proven source correction plus the unattended scheduled 27-test regression canary. Never discard, force-reset, clean, prune, or overwrite these.

## Native V3 scope

The existing 13 MCP tools remain in the approved tool list. plan_scoped_worktree and create_scoped_worktree add optional baseline_mode=remote-main (default: local-main), and expected_local_main_sha (40-hex SHA, mandatory when remote-main). expected_main_sha pins the fetched remote main in remote mode. The native code verifies the current local main, both SHA preconditions, that the remote is a fast-forward descendant, and unchanged journal/state hashes. It creates a NEW fixed branch revenue-shot/fleet-v3-PROJECT-REPOSITORY in a new fixed maintenance-directory worktree; it never fetches, pushes, merges or modifies checked-out main. Old v1 lanes and their action receipts survive. A separate bootstrap intent/result directory prevents replay.

The reader permits exactly registered, unprunable/unlocked v1/v3 branch/path combinations and checks source allowlists, symlinks and realpath. The scoped writer also restricts external write locations to these exact fixed lanes. It retains a per-worktree exclusive owner.lock, source SHA/CAS checks, atomic replace, and durable intent/result records.

The fixed seven unit suites remain in force; no arbitrary model-supplied command, package installation, network provider request, protected Git/CI operation or paid API is granted. Missing dependencies must be reported as failures, not successes.

## Scheduled worker policy

The new FLEET_V3_SCOPED_AUTH_20261101 header is enabled in all six original developer-worker automations. It grants ongoing, owner-approved NATIVE scoped edits/tests only in verified fresh v3 worktrees after installation and tool refresh, with pinned exact Git SHAs per repository. Both source-diff and project-unit receipts must pass for each authentic unique run key. The canonical writer inspector's hardcoded UNKNOWN remains a blocker for CANONICAL writing but not, by this separate express authorization, for the per-worktree isolated action guarded by exclusive owner.lock and SHA/CAS/receipts. All original archived-kernel, privacy, spending, consent, release and Git guards remain effective for their original scope. Previously denied actions are not retried through shell or alternate tools, and no historical UNKNOWN run is rewritten.

The old one-shot NoFax pilot completed and must not be replayed.

## Verification

Staged tests cover v1 preservation, v3 remote-main branch from exact SHA, canonical checkout preservation, project-specific fixture unit+diff checks, refusal of wrong SHA and non-fast-forward remote, native tool schema, v1 reader compatibility and noninteractive install refusal.

Read-only validation:

    node scripts/prepare-revenue-fleet-v3.mjs --check
    node --test scripts/fleet-scoped-worktree-actions.test.mjs scripts/prepare-revenue-fleet-v3.test.mjs

Owner Windows PowerShell as Administrator, during an idle gap:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\lol\codexify-njs-repair-20261031\scripts\activate-revenue-fleet-v3.ps1"

The script checks exact pre-upgrade SHA hashes, the patched Codexify binary and healthy service; requests typed APPROVE REVENUE FLEET V3; backs up and swaps only four sidecar files; verifies 13 approved actions and the legacy NoFax reader; restarts only the existing Codexify task and verifies HTTP200 plus MCP catalog. Hash-verified rollback is attempted on any failure. It does not edit scheduled tasks, canonical repositories or original journal/state.

Expected confirmation:

    SUCCESS: FLEET_V3_FRESH_MAIN_READER_HTTP200

Then refresh God v5 Actions. The existing six prompts can use the new baseline_mode input to create/reuse seven v3 worktrees, respecting pinned remote/main SHAs and no concurrency. Verify one authentic hosted unattended edit and both fixed checks for each project. If real-project suites lack dependencies, do not install or bypass denied packages automatically; identify the exact blocker.

Limits: A single remote fetch does not guarantee continuous freshness. Future upstream changes need a separately authorized, non-destructive source-lane migration. This upgrade intentionally does not automatically prune worktrees, rewrite original history, push protected Git refs, deploy releases or establish blanket canonical writer ownership.
