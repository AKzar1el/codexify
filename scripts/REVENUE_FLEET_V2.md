# Revenue Shot fleet v2 — external reader and project-unit tests

Status: staged and tested. NOT installed in the live sidecar. The existing seven ChatGPT schedules and canonical journals remain unchanged.

The old read_project_worktree_file tool rejected the maintenance-directory worktree even though the new scoped writer approved it. The v2 reader accepts only an exact Git-registered, non-prunable, non-locked external fleet worktree under its configured root and expected branch, with fixed repository alias, real-path/symlink checks and read/source allowlists. It preserves the older in-project reader behavior.

The existing run_scoped_worktree_check tool adds check_id=project-unit. Its commands are fixed per repository, without arbitrary model-supplied shell commands. Each result gets a separate durable check receipt, allowing source-diff and unit results on the same edit. It honors existing legacy check receipts. The global canonical write/check switches stay disabled.

Approved unit suites:
- GEO: node --import tsx --test tests/matching.test.ts
- GodPrompt primary: python -m pytest -q -p no:cacheprovider tests/test_policy.py (cwd bench)
- GodPrompt companion: node --test tests/normalize-mcpb.test.mjs
- GSC: node --test tests/launcher.test.mjs
- NoFax: node --test test/mcp-tools.test.mjs
- TrendPulse: python -m pytest -q -p no:cacheprovider -m "not integration and not network and not browser" tests/test_article_url_validation.py
- Web Validator: node --test test/report.test.js

Tests execute in isolated worktrees with bounded runtime/output and reduced environment. No dependency installation, provider requests or releases are automatically authorized. A fresh external worktree may lack Node dependencies or build artifacts; those checks must fail visibly rather than be marked successful.

Verified source correction: NoFax src/mcp-tools.mjs on branch revenue-shot/fleet-v1-nofax-root handles a failed auxiliary confirmation after a durable human decision without throwing away the terminal decision. A follow-up surgical edit preserved the successful terminal response's original shape (necessary for existing deep-equality tests). Final source SHA: 48d7bbf6e3730a5ad754cc5daa8d811ba67295162d1e6b5883ce393ac893ad0b. Latest run key: nofax-confirmation-shape-preserve-20261101. Both approved source edits and source-diff checks passed; no canonical source change, commit, deployment or remote Git effect. Full NoFax unit tests still need activation, and an explicit regression test should be added before release.

Read-only verification:
    node scripts/prepare-revenue-fleet-v2.mjs --check
    node --test scripts/prepare-revenue-fleet-v2.test.mjs scripts/fleet-scoped-worktree-actions.test.mjs

All nine combined fixture/integration tests passed. The tests cover external reader validation and path-denial, a real disposable Git worktree, bounded file edit, fixed NoFax unit fixture, independent check receipts, noninteractive install refusal and seven-repository test-file existence.

Owner-authorized activation, in Windows PowerShell as Administrator, at an idle gap:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\lol\codexify-njs-repair-20261031\scripts\activate-revenue-fleet-v2.ps1"

The script verifies exact pre-upgrade hashes, original patched executable and healthy service; requests typed approval; creates backups, swaps only the four sidecar files, validates the 13-tool MCP catalog and new reader, restarts only Codexify, and attempts hash-verified rollback on failure. It never edits the seven scheduled automations or historical journals.

After successful restart, refresh God v5 app Actions to include the project-unit enum, then call the approved NoFax project-unit check using the latest verified edit run key nofax-confirmation-shape-preserve-20261101. Only after its test output passes should the hourly workers count meaningful code validation as operational. Existing GSC/NoFax historical terminal gaps remain UNKNOWN and must not be fabricated or replayed.
