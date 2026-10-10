# Agent Chat Browser Automation Implementation Plan

> **Execution rule:** follow this plan with strict red-green-refactor TDD. For every production behavior, first add the smallest failing test, run it and confirm the expected failure, then implement only enough to make it pass. Keep `docs/superpowers/progress/2026-10-09-agent-chat-browser-automation.md` current after every task, verification run, commit, and blocker.

**Goal:** Implement the approved optional browser automation for standalone Codexify agent chat: explicit ChatGPT URL pairing, existing-presence offline fallback for unread messages and goals, one shared browser window, exact model/effort verification, streamed browser output, secure persistent state, and no Codex model-provider integration.

**Architecture:** Rust remains authoritative for stable task identity, secure state, URL pairing, goals, unread batching, offline detection, queue policy, and transcript persistence. An optional TypeScript/Electron companion owns only ChatGPT login, one long-lived browser window, DOM selectors, exact URL/model/effort/connector verification, submission observation, and visible response extraction. The two processes communicate over a private authenticated loopback protocol. The existing online `CHAT.md` path remains unchanged.

**Baseline:** Codexify `v1.7.0` (`f269d56`), upstream browser source `miuuyy/codex-chatgpt-web` `v6.1.7` (`f9ad4ae83a579287105ad822dd0c3e0029b04ef6`).

---

## Task 1: Establish clean baseline and commit approved documentation

**Files:**
- Existing: `docs/superpowers/specs/2026-10-09-agent-chat-browser-goal-runner-architecture.md`
- Existing: `docs/superpowers/progress/2026-10-09-agent-chat-browser-automation.md`
- New: `docs/superpowers/plans/2026-10-09-agent-chat-browser-automation.md`

**Steps:**
1. Finish the existing `cargo test --all` baseline run.
2. Record exact pass/fail counts and elapsed time in the progress journal.
3. Run `git diff --check`.
4. Commit the approved architecture, plan, and initial progress journal as `docs: plan agent chat browser automation`.

**Verification:**
```sh
cargo test --all
git diff --check
git status --short
```

---

## Task 2: Add stable configuration and connector schema surface

**Files:**
- Modify: `src/markdown_chat/mod.rs`
- Modify: `src/config.rs`
- Modify: `src/types.rs` only if a shared public type is required
- Modify: `codexify.config.json`
- Modify: `codexify.config.example.json`
- Modify: `src/connector_schema.rs`
- Modify: `src/registry.rs`
- Modify: `src/tools/mod.rs`
- Modify: `tests/markdown_chat.rs`
- Modify: `tests/meta_suite.rs`
- Modify: `src/tools/setup.rs` tests

**Behavior:**
- Add `agentChat.automation` with:
  - `enabled: bool` default `false`
  - `descriptorPath: String` default `~/.codexify/browser/descriptor.json`
  - `connectorName: String` default `Codexify`
  - `maxQueuedActions: usize` default `64`, bounded `1..=1024`
  - `autoApproveToolCalls: bool` default `false`
- Reject automation when `agentChat.enabled` is false.
- Validate descriptor path and connector name without resolving or touching the companion.
- Add the model-visible tools `automation_verify_pairing`, `goal_read`, and `goal_finish` whenever agent chat is enabled. Their runtime calls return an explicit disabled error while automation is disabled.
- Add connector marker `+agent-automation-v1` whenever agent chat is enabled, independent of `automation.enabled`, so toggling the local runtime feature does not change cached schemas.

**TDD:**
1. Add config tests proving defaults, valid overrides, unknown-field rejection, bad queue limits, blank connector names, and the `agentChat.enabled` dependency.
2. Run targeted tests and confirm failure because the types/keys do not exist.
3. Add registry/meta tests proving the three tool names and marker are stable across `automation.enabled=false/true` but absent when agent chat is disabled.
4. Implement config and registry scaffolding with placeholder tool handlers that only report disabled/not-initialized state.
5. Update bundled configs and complete-surface key tests.

**Verification:**
```sh
cargo test --test markdown_chat config_loader_reads_agent_chat -- --exact
cargo test --lib config::tests::shipped_config_examples_track_the_complete_supported_surface
cargo test --test meta_suite includes_expected_tool_names
cargo test --lib tools::setup::tests::feature_toggles_require_reload_then_a_new_conversation
```

**Commit:** `feat: configure agent chat browser automation`

---

## Task 3: Implement secure task-scoped automation persistence

**Files:**
- New: `src/agent_automation/mod.rs`
- New: `src/agent_automation/store.rs`
- Modify: `src/lib.rs`
- Modify: `src/conversation_continuations.rs`
- New: `tests/agent_automation_store.rs`

**Domain model:**
- `AgentAutomationStore`, rooted beside task chat state.
- `AutomationTaskState` version 1 with pairing, selection, goal, chat-mirror, current action, and goal-wake state exactly as specified.
- Goal states: absent/configured/active/completed/blocked/error; no pause/resume.
- Action states: unpaired/unverified/queued/navigating/sending/generating/idle/approval_required/authentication_required/rate_limited/interference/ambiguous/stalled/failed.
- Pairing stores candidate URL, canonical URL, pairing generation, verified physical-owner generation, timestamp, and one optional pending token record containing only a SHA-256 digest plus expiry.
- Goal text maximum: 10 KiB UTF-8.
- Pairing URL maximum: 4096 bytes.
- Bounded summaries/errors/output; no unrestricted diagnostic payloads.

**Security and durability:**
- Private real directories and regular files; reject symlinks/devices.
- Unix modes 0700/0600 and current-user ownership checks.
- Cross-process lock compatible with existing project state patterns.
- Bounded parse and explicit version.
- Atomic temporary write, flush/sync, rename/publish.
- Preserve corrupt state and fail closed.
- No raw pairing token persisted.

**Continuation integration:**
- Expose a read-only `owner_snapshot` API from `ConversationContinuationStore` returning stable task, physical owner hash, and generation without exposing raw session IDs.
- A fresh task without a continuation record has generation zero and owner equal to its physical stable key.

**TDD:**
1. Add tests for round-trip persistence, private modes, symlink rejection, corruption, oversized state, concurrent mutations, and atomic publication.
2. Add tests for goal revision increments, 10 KiB boundary, blocked reason requirement, stale expected revision, stop/clear semantics, and absence of pause/resume.
3. Add pairing-token tests for high entropy, digest-only persistence, expiry, replay rejection, and owner-generation comparison.
4. Add continuation-owner snapshot tests for initial, continued, active, and retired conversations.
5. Implement minimal store APIs until all tests pass.

**Verification:**
```sh
cargo test --test agent_automation_store
cargo test --lib conversation_continuations
```

**Commit:** `feat: persist agent automation state`

---

## Task 4: Add structured unread-chat and browser-output primitives

**Files:**
- Modify: `src/markdown_chat/storage.rs`
- Modify: `src/markdown_chat/widget.rs`
- Modify: `src/markdown_chat/mod.rs`
- Modify: `tests/markdown_chat.rs`
- Modify: `tests/markdown_chat_tools.rs`
- New or modify: focused module tests in `src/markdown_chat/widget.rs`

**Behavior:**
- Add a structured non-consuming unread snapshot returning bounded user-message records with stable IDs, original Markdown, start/end offsets, transcript revision, and current read offset.
- Raw editor appends receive deterministic synthetic IDs tied to stable byte spans.
- Add a transcript checkpoint API that records file revision/end and can determine whether an agent block appeared after the checkpoint.
- Add idempotent `append_browser_answer(action_id, markdown)` using an internal browser-action marker. Repeating the same action with identical text is a no-op; conflicting text fails.
- Browser append must not advance the user read cursor, delivered cursor, tool count, presence, or waiting state.
- Add a generic `OfflineActivity` snapshot and independent claim namespaces so notifications and browser goal-only nudges do not consume one another's claim.
- Preserve current `chat_read`, `chat_write`, `chat_await`, widget paging, and manual-file behavior.

**TDD:**
1. Test unread structured snapshots across ordinary user blocks, manual appends, agent blocks, warnings, and partial/incomplete files.
2. Test that snapshots do not consume or mark delivery.
3. Test browser-answer idempotency and cursor/activity invariants.
4. Test checkpoint detection when `chat_write` races browser completion.
5. Test independent offline claims for notification and automation namespaces.
6. Implement and run all existing Markdown-chat suites.

**Verification:**
```sh
cargo test --lib markdown_chat::storage
cargo test --lib markdown_chat::storage::widget
cargo test --test markdown_chat --test markdown_chat_tools --test markdown_chat_timestamps
```

**Commit:** `feat: expose safe chat automation primitives`

---

## Task 5: Implement model-visible goal and pairing tools

**Files:**
- New: `src/tools/goal.rs`
- New: `src/tools/automation_pair.rs`
- Modify: `src/tools/mod.rs`
- Modify: `src/registry.rs`
- Modify: `src/tool.rs`
- Modify: `src/server.rs`
- Modify: `src/instructions.rs`
- Modify: `src/tools/get_agent_brief.rs`
- Modify: `tests/meta_suite.rs`
- New: `tests/agent_automation_tools.rs`

**Context wiring:**
- Add `Arc<AgentAutomationStore>` and `Arc<ConversationContinuationStore>` or a narrow owner resolver to `ToolRequestContext`.
- Tools require stable physical and task conversation identities and ordinary connector authorization.

**Tool contracts:**
- `automation_verify_pairing({ reference })`
  - write-only bounded reference;
  - validates pending token, current physical conversation resolves active to the expected stable task, current owner generation matches, and candidate canonical URL was recorded by the companion;
  - consumes token on success and mismatch/replay paths as specified;
  - does not authorize setup or transfer ownership.
- `goal_read({})`
  - read-only in annotation only if it performs no cursor/state mutation;
  - returns disabled/no-goal/configured/active/completed/blocked/error state, text, revision, summary, and blocked reason with bounded schema.
- `goal_finish({ expected_revision, status, summary?, reason? })`
  - accepts only completed/blocked;
  - blocked requires concrete reason;
  - stale revisions fail without mutation;
  - marks terminal state once; exact idempotent replay succeeds.

**Instructions:**
- `get_agent_brief` appends goal guidance only when the task has an active goal.
- The general Markdown-chat state machine remains unchanged; a successful exact `goal_finish` receipt is the explicit terminal condition for the browser-driven action.

**TDD:**
1. Add schema/annotation tests before implementations.
2. Add end-to-end tool tests for disabled state, missing identities, authorization gate, correct pairing, mismatch, expiry, replay, active goal read, completion, blocked reason, and stale revision.
3. Implement context wiring and tools.
4. Verify every advertised schema with `jsonschema`.

**Verification:**
```sh
cargo test --test agent_automation_tools
cargo test --test meta_suite
cargo test --lib tools::goal
cargo test --lib tools::automation_pair
```

**Commit:** `feat: add agent automation MCP tools`

---

## Task 6: Implement the authenticated companion protocol client

**Files:**
- New: `src/agent_automation/companion.rs`
- Modify: `src/agent_automation/mod.rs`
- New: `tests/agent_automation_companion.rs`

**Descriptor validation:**
- Default path expansion, real regular file, bounded JSON, explicit version/kind, current-user private permissions on Unix, live PID, loopback `http://127.0.0.1:<port>` only, high-entropy bearer, protocol/build field.
- Never put bearer/URL/prompt text in errors or debug output.

**Client API:**
- health, login, capabilities, reveal, execute, cancel, action state, event stream.
- Request and response body size limits.
- Per-stage timeouts and cancellation.
- No redirects.
- Exact event enum and strict monotonic sequence validation.
- Execute idempotency reconciliation: retry only pre-acceptance request transport ambiguity with the same action/idempotency key; never create a new action automatically.

**TDD:**
1. Use local Axum fake companion fixtures.
2. Test descriptor path/permissions/symlinks/PID/origin/token redaction.
3. Test bearer authentication, protocol mismatch, bounded JSON, redirects, timeout, cancellation, event order, unknown events, and accepted-send no-replay behavior.
4. Implement client.

**Verification:**
```sh
cargo test --test agent_automation_companion
```

**Commit:** `feat: add browser companion protocol client`

---

## Task 7: Implement the Rust global queue and offline supervisor

**Files:**
- New: `src/agent_automation/supervisor.rs`
- Modify: `src/agent_automation/mod.rs`
- Modify: `src/server.rs`
- Modify: `src/owner_chat.rs`
- Modify: `src/markdown_chat/mod.rs`
- New: `tests/agent_automation_supervisor.rs`

**Queue policy:**
- One global action at a time.
- Pair verification has explicit-user priority; unread chat outranks goal-only work.
- Coalesce unsent unread batches for the same task within prompt bounds.
- No consecutive goal-only slot when another task has unread chat.
- Snapshot and revalidate pairing generation, owner generation, model, effort, goal revision, unread IDs, and companion/account revision immediately before execution.
- Queue capacity enforced; overload leaves chat unread and reports bounded state.
- Changing URL/model/effort/goal invalidates stale queued actions.

**Offline policy:**
- Use existing persisted `last_agent_call_at_ms` and `OFFLINE_AFTER_MS`.
- Online append never enqueues browser work.
- Offline unread message can enqueue without goal.
- Goal-only one nudge per activity epoch; accepted wake with no subsequent model-visible tool activity becomes stalled.
- Browser mirror never acknowledges unread messages.
- New messages during generation form a future action.

**Prompt construction:**
- Fixed pair/offline-chat/offline-goal/offline-combined templates from the spec.
- XML-like unread data escaped as data.
- Bounded total prompt; split unread messages across actions rather than truncate a message silently.
- Goal text fetched by model through `goal_read`, not embedded in the browser prompt.

**Output handling:**
- Publish transient status/commentary/answer deltas to task automation state for owner-page polling/streaming.
- Record transcript checkpoint at start.
- At terminal completion, append stable final answer only if no `chat_write` agent block appeared after checkpoint.
- Do not persist status/commentary rows.
- Never mark agent online from browser events.

**TDD:**
1. Build a fake companion implementation and deterministic clock.
2. Test all eligibility, priority, coalescing, fairness, invalidation, stalled, capacity, restart, ambiguous-send, and no-ack behavior.
3. Test output fallback versus racing `chat_write`.
4. Test helper failure leaves ordinary chat functional.
5. Implement supervisor and startup wiring.

**Verification:**
```sh
cargo test --test agent_automation_supervisor
cargo test --lib server::tests::only_model_visible_calls_start_offline_notification_monitors
```

**Commit:** `feat: supervise offline browser chat actions`

---

## Task 8: Extend standalone owner-chat APIs and local commands

**Files:**
- Modify: `src/owner_chat.rs`
- Modify: `src/owner_chat.html`
- Modify: `scripts/test-owner-chat.mjs`
- Modify: `src/server.rs`
- New or modify: owner-chat Rust tests

**Owner API:**
- Extend list/state payload with automation enabled, presence, pairing, selection, goal, action, queue position, companion health, capabilities, and bounded stream state.
- Add authenticated endpoints for:
  - pair candidate, verify, replace, unlink;
  - model/effort selection;
  - companion login, capabilities refresh, reveal;
  - goal set/run/stop/clear/status;
  - action retry/cancel/status/events.
- All browser access remains server-side. Owner HTML receives no companion token or endpoint.
- Support configured reverse proxy host safely only through an explicit public URL/allowed-host policy; otherwise retain loopback Host protection.

**Slash commands:**
- Intercept exactly `/goal set`, `/goal run`, `/goal stop`, `/goal clear`, `/goal status` before `append_user`.
- `//goal` removes one leading slash and sends an ordinary literal message.
- Commands never enter `CHAT.md`.
- Request IDs make mutating commands idempotent.

**TDD:**
1. Rust API tests for authorization, body bounds, URL syntax, command parsing, idempotency, state transitions, and hidden secrets.
2. Chromium/WebKit owner tests for online ordinary send with zero automation calls, offline send without goal, URL pairing controls, model/effort capability filtering, goal lifecycle, stream state, errors, queue positions, and mobile layout.
3. Embedded widget test proves no automation controls/callbacks.
4. Implement API then UI incrementally.

**Verification:**
```sh
cargo test --lib owner_chat
node --test scripts/test-owner-chat.mjs scripts/test-markdown-chat-widget.mjs
```

**Commit:** `feat: add standalone chat automation controls`

---

## Task 9: Extract the upstream browser core with attribution

**Files:**
- New directory: `browser-companion/`
- New: `browser-companion/package.json`
- New: `browser-companion/tsconfig.json`
- New: `browser-companion/src/protocol.ts`
- New: `browser-companion/src/session.ts`
- New: `browser-companion/src/models.ts`
- New: `browser-companion/src/model-selection.ts`
- New: `browser-companion/src/connector-selection.ts`
- New: `browser-companion/src/composer.ts`
- New: `browser-companion/src/turn-binding.ts`
- New: `browser-companion/src/response-stream.ts`
- New: `browser-companion/src/browser-window.ts`
- New: `browser-companion/src/control-server.ts`
- New: `browser-companion/src/main.ts`
- New: `browser-companion/tests/*.test.ts`
- New: `browser-companion/UPSTREAM.md`
- New: `LICENSES/codex-chatgpt-web-MIT.txt`
- New or modify: `THIRD_PARTY_NOTICES.md`
- New: `scripts/update-browser-companion-upstream.sh`

**Source policy:**
- Copy/adapt exact source from upstream commit `f9ad4ae` for session/composer selectors, model/effort verification, connector selection, exact insertion, send acceptance, logical turn binding, stable Markdown conversion, visible status/commentary/answer extraction, login/approval/rate-limit/error handling, and relevant regression fixtures.
- Preserve copyright/license headers and record source paths/commit.
- Do not copy Responses server, Codex catalog/provider integration, prompt compiler, compaction transport, subagent protocol, tunnel broker, or multi-tab retention.

**One-window architecture:**
- One persistent Electron BrowserWindow/session partition.
- A single in-process action mutex/queue guard; Rust remains canonical queue owner.
- Exact URL navigation only; no latest/recency discovery.
- Never navigate while an owned response is generating.
- Detect unexpected user navigation/send/draft/model/connector mutation as interference.
- Fixed protocol operations only; no arbitrary selector or JS RPC.

**TDD:**
1. Start with copied/adapted upstream parser/selector fixtures and verify they fail against missing modules.
2. Port unit tests for account capability, model family, effort, connector, composer insertion, submission evidence, turn binding, Markdown streaming, approvals/rate limits, ambiguous send, and drift.
3. Add one-window tests using mocked Electron/Playwright pages: serialization, exact navigation, no navigation during generation, external interference, cancellation, reconnect, and event stream.
4. Implement control server and descriptor publication with private permissions, loopback-only bearer auth, bounded bodies, strict protocol versioning, and redacted logs.
5. Typecheck and run all companion tests.

**Verification:**
```sh
cd browser-companion
bun install --frozen-lockfile
bun run typecheck
bun test
```

**Commit:** `feat: add single-window ChatGPT browser companion`

---

## Task 10: Integrate real companion contract and end-to-end fake/browser tests

**Files:**
- Modify: `src/agent_automation/companion.rs`
- Modify: `src/agent_automation/supervisor.rs`
- Modify: `browser-companion/src/control-server.ts`
- Modify: `browser-companion/src/protocol.ts`
- New: `tests/agent_automation_contract.rs`
- New: `browser-companion/tests/protocol-contract.test.ts`
- New: `scripts/test-agent-automation-contract.mjs` if a cross-process fixture is clearer

**Behavior:**
- Pin a protocol schema/hash shared by generated test fixtures.
- Verify Rust/TypeScript request and event JSON shapes in both directions.
- Cover health, capabilities, reveal, execute, cancel, status, events, version mismatch, auth, bounds, and restart reconciliation.
- Accepted actions remain non-replayable across dropped HTTP/event connections.

**TDD:**
1. Add golden JSON contract fixtures and make both implementations parse them.
2. Add cross-process fake companion and fake Rust server tests.
3. Resolve every contract mismatch without weakening validation.

**Verification:**
```sh
cargo test --test agent_automation_contract
cd browser-companion && bun test tests/protocol-contract.test.ts
```

**Commit:** `test: verify browser automation protocol contract`

---

## Task 11: Add companion lifecycle, diagnostics, and packaging

**Files:**
- New: `src/agent_automation/install.rs`
- Modify: `src/doctor.rs`
- Modify: `src/main.rs`
- Modify: `src/config.rs` CLI enums
- Modify: `src/service.rs` only for user-session launch integration if required
- New: `browser-companion/scripts/build.ts`
- New: `browser-companion/electron-builder.yml` or package build config
- Modify: `install.sh`
- Modify: `install.ps1`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/release-cache.yml`
- Modify: `tests/ci_workflows.rs`
- Add installer/doctor tests

**CLI and lifecycle:**
- Add `codexify browser status|login|reveal|start|stop|install` or an equivalent explicit command family.
- Do not start/download anything when automation is disabled.
- Install verified version-pinned artifacts under `~/.codexify/browser/runtime/<version>/` from release checksums.
- Descriptor/protocol must match current Codexify before use.
- Doctor reports disabled, missing, stopped, incompatible, unauthenticated, healthy, and account-changed states without secrets.
- Service restart does not destroy the user-session companion.

**Packaging:**
- Build platform artifacts for supported release targets.
- Include companion artifacts/checksums in GitHub release workflow.
- Update installers to optionally install the companion only when requested/configured; preserve ordinary server installs.
- CI runs companion typecheck/tests and source/package smoke tests without account-bound live ChatGPT access.

**TDD:**
1. Add CLI parser and install-path/checksum tests before implementation.
2. Add doctor fixtures for each state.
3. Add workflow contract tests before YAML changes.
4. Add package smoke test that launches the companion against a local fake page/control fixture.

**Verification:**
```sh
cargo test --lib doctor
cargo test --test ci_workflows
./scripts/test-posix-installer.sh
pwsh ./scripts/test-windows-installer.ps1
cd browser-companion && bun run build && bun run smoke
```

**Commit:** `feat: package agent chat browser companion`

---

## Task 12: Documentation, security, and migration

**Files:**
- Modify: `README.md`
- Modify: `docs/REFERENCE.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `codexify.config.example.json`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: security/redaction tests (`src/redaction.rs`, `src/audit.rs`, `src/tool_logging.rs` tests)
- Update progress journal

**Documentation:**
- Explain explicit URL pairing and why there is no heuristic.
- Explain online versus offline behavior, ordinary unread messages without goals, goals, one-window queue, streamed fallback output, pairing verification, model/effort controls, and failure states.
- Explain optional companion install/login and how automation disabled leaves current behavior unchanged.
- Document private files and redaction guarantees.
- State that browser automation is unofficial and UI drift fails closed.
- Record upstream commit and MIT attribution.

**Security verification:**
- Add redaction coverage for ChatGPT URLs, pairing tokens, companion bearer, prompts, goals, browser output, and account fingerprints.
- Audit and tool payload logging never contain private automation state.
- Owner page never receives companion descriptor/token.
- No raw private values appear in errors.

**Verification:**
```sh
cargo test redaction
cargo test audit
cargo test tool_logging
cargo test --test skills_and_docs
```

**Commit:** `docs: document agent chat browser automation`

---

## Task 13: Full verification and code review

**Fresh verification:**
```sh
cargo fmt --all --check
rustfmt --edition 2024 --check \
  src/server_markdown_chat_tests.rs \
  src/server_markdown_chat_widget_tests.rs \
  src/server_workspace_tests.rs \
  src/server_agent_ticket_tests.rs
cargo clippy --all-targets -- -D warnings
cargo test --all
python3 -m unittest scripts.test_release_notarization -v
node --test scripts/test-setup-widget.mjs
node --test --test-concurrency=1 \
  scripts/test-markdown-chat-widget.mjs \
  scripts/test-owner-chat.mjs \
  scripts/test-chat-workspace-switch.mjs \
  scripts/test-workspace-widget.mjs \
  scripts/test-workspace-picker.mjs
cd browser-companion
bun run typecheck
bun test
bun run build
bun run smoke
cd ..
git diff --check
git status --short --branch
```

**Review checklist:**
- Compare every architecture invariant and testing bullet to implemented code/tests.
- Confirm no Web model/catalog/Responses integration entered Codexify.
- Confirm no heuristic URL discovery.
- Confirm online path never invokes companion.
- Confirm one browser window globally and no retained per-task tab pool.
- Confirm browser mirror never acknowledges unread messages.
- Confirm `chat_write` suppression of duplicate browser persistence.
- Confirm no pause/resume goal states and 10 KiB limit.
- Confirm ambiguous Send is never replayed.
- Confirm secrets/private content are redacted.
- Run `show_diff` once after all related changes.
- Use the code-review skill, resolve all findings, rerun affected verification.
- Commit any final fixes separately.

**Completion:**
- Update progress journal with all commits, test evidence, live-test limitations, and exact remaining operational setup.
- Invoke branch-finishing workflow and offer merge/PR/keep/discard choices; do not remove the harness-owned worktree.
