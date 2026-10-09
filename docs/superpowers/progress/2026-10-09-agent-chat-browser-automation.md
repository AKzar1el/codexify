# Agent Chat Browser Automation Progress

**Last updated:** 2026-10-09

**Branch:** `feat/agent-chat-browser-automation`

**Architecture:** `docs/superpowers/specs/2026-10-09-agent-chat-browser-goal-runner-architecture.md`

**Upstream browser reference:** `miuuyy/codex-chatgpt-web` tag `v6.1.7`, commit `f9ad4ae`

## Objective

Implement the approved agent-chat browser automation architecture completely: retain Codexify's existing online chat behavior, add explicit ChatGPT URL pairing, use one shared long-lived browser window for offline fallback, stream stable visible browser output into standalone chat, add the bounded goal lifecycle, and keep all Web-model routing out of Codex.

## Current status

- Read the complete 1,336-line revised architecture.
- Loaded the project instructions and implementation workflow skills.
- Confirmed the checkout is an existing isolated Git worktree.
- Created branch `feat/agent-chat-browser-automation` from `v1.7.0` / `f269d56`.
- The approved architecture, executable plan, and progress journal are committed.
- Cloned the exact upstream browser reference into `/tmp/codex-chatgpt-web-v6.1.7` at `f9ad4ae83a579287105ad822dd0c3e0029b04ef6`.
- Wrote and self-reviewed the detailed TDD plan at `docs/superpowers/plans/2026-10-09-agent-chat-browser-automation.md`.
- The first baseline build on the external `/Volumes/data` target stalled in uninterruptible filesystem I/O and was cancelled without a test result. The same suite was rerun with a fresh isolated target under `/tmp` and passed completely.
- Committed the approved architecture, executable plan, and initial progress journal as `a00c297` (`docs: plan agent chat browser automation`).
- Implemented the first configuration/schema slice:
  - added `agentChat.automation` defaults and validation;
  - added the stable `+agent-automation-v1` connector marker;
  - advertised `automation_verify_pairing`, `goal_read`, and `goal_finish` whenever agent chat is enabled, independent of the runtime automation toggle;
  - added initial disabled-state tool contracts;
  - increased connector-version marker bounds from 64 to 128 bytes so the explicit feature marker remains lossless.
- Committed that slice as `9b30eb7` (`feat: configure agent chat browser automation`).
- Implemented secure task-scoped automation state:
  - versioned private `automation.json` records beside stable task chat state;
  - cross-process file locks plus process-local serialization across store instances;
  - atomic bounded JSON persistence, symlink/type/owner/mode checks, and fail-closed corruption handling;
  - 10 KiB revisioned goal lifecycle with `configured`, `active`, `completed`, `blocked`, and `error` states only;
  - exact-revision completion, mandatory blocked reasons, terminal idempotency, stop/clear semantics, and no pause/resume state;
  - random digest-only one-time pairing references with expiry, canonical URL staging, owner-generation binding, replay rejection, and single use;
  - continuation owner snapshots exposing only stable hashes and generation, now used by server dispatch for active/retired routing.
- Committed that slice as `8d80f66` (`feat: persist agent chat automation state`).
- The current uncommitted slice implements the chat primitives required by the future supervisor:
  - structured non-consuming unread-message snapshots with stable IDs, original Markdown, byte ranges, timestamps, and transcript revisions;
  - transcript checkpoints and detection of tool-written agent messages after an action starts;
  - idempotent browser-answer fallback appends tagged by browser action ID;
  - browser fallback appends do not acknowledge unread messages, advance delivery/read cursors, record agent activity, or alter tool counts;
  - notification and browser-goal offline claims are independent and persist across restart;
  - existing chat reads, writes, history, timestamps, notifications, and widget behavior remain intact in focused tests.
- Committed that slice as `27a0d9b` (`feat: expose chat browser fallback primitives`).
- Resumed from `2079c95`, reread the complete revised architecture, this progress
  journal, and the 13-task implementation plan, and confirmed the working tree was
  clean before continuing.
- Task 5 is in progress: replace the placeholder `goal_read`, `goal_finish`, and
  `automation_verify_pairing` handlers with task-scoped implementations, wire the
  automation store and continuation owner generation through request context, and
  add active-goal guidance to `get_agent_brief`.
- Task 5's first red-green slice is now green:
  - request context carries the current continuation owner generation and an
    effective task-rooted automation store;
  - `goal_read` returns the bounded revisioned goal state;
  - `goal_finish` enforces exact revisions, completed summaries, and mandatory
    blocked reasons with idempotent terminal receipts;
  - `automation_verify_pairing` resolves one-time references through a private
    digest index shared across project-state roots, consumes
    mismatched/expired/replayed references, and exposes no URL or task identity;
  - active goals add browser-specific `goal_read`/`goal_finish` guidance to
    `get_agent_brief` without embedding the goal text.

## Required invariants

- Browser automation is an offline fallback; while the task is online, existing `CHAT.md` and tool-result delivery remains unchanged.
- Offline uses Codexify's existing five-minute task-presence rule.
- Unread ordinary chat can wake a paired offline task without an active goal.
- The user supplies the exact ChatGPT URL; no recency or project heuristic is permitted.
- URL pairing never transfers or retires task ownership.
- A one-time `automation_verify_pairing` call must prove that the pasted URL belongs to the intended stable task before private content is sent.
- One persistent browser window is shared globally; Rust owns the serialized queue.
- Web models and efforts are visible only in standalone agent chat, never in Codex's model catalog.
- Browser answer text is streamed only for browser-driven offline actions. `chat_write` remains authoritative persisted output.
- Goals are limited to 10 KiB, have `set/run/stop/clear/status`, and finish only through `goal_finish`; blocked goals require a reason.
- Ambiguous Send, selector drift, approval requirements, rate limits, and model/effort mismatch fail closed.

## Planned work

1. Map current Codexify modules and the exact upstream browser-harness subset.
2. Write and self-review a detailed implementation plan.
3. Add configuration, domain state, persistence, pairing, goals, and tools with TDD.
4. Add the companion protocol client, queue, offline supervision, and response persistence with TDD.
5. Extract the single-window TypeScript/Electron companion with upstream attribution and focused tests.
6. Extend the standalone owner-chat API/UI and preserve embedded-widget isolation.
7. Add packaging, doctor/setup/update support, docs, third-party notices, and release integration.
8. Run full Rust, browser, companion, packaging, formatting, and lint verification; review the final diff; commit in coherent steps.

## Verification log

- Baseline passed: `CARGO_TARGET_DIR=/tmp/codexify-target-agent-automation-1791553656 CARGO_PROFILE_DEV_DEBUG=line-tables-only CARGO_PROFILE_TEST_DEBUG=line-tables-only cargo test --all` (exit 0; 576 library tests plus every integration and doc-test target passed; only explicitly environment-gated tests were ignored).
- `git diff --check` passed for the implementation plan.
- Red phase: `cargo test --test markdown_chat agent_chat_automation_defaults_overrides_and_validation -- --exact` failed because `MarkdownChatConfig` had no `automation` field.
- Green configuration/schema verification:
  - `cargo test --test markdown_chat` — 15 passed;
  - `cargo test --test meta_suite` — 39 passed;
  - `cargo test --lib config::tests::shipped_config_examples_track_the_complete_supported_surface` — passed;
  - `cargo test --lib tools::setup::tests::feature_toggles_require_reload_then_a_new_conversation` — passed;
  - connector marker and 128-byte setup marker tests — passed;
  - `cargo fmt --all` and `git diff --check` — passed.
- Store red phase: `cargo test --test agent_automation_store` failed because `codexify::agent_automation` did not exist.
- Store green verification:
  - `cargo test --test agent_automation_store` — 6 passed;
  - `cargo test --lib conversation_continuations` — 8 passed;
  - `cargo clippy --test agent_automation_store -- -D warnings` — passed;
  - `cargo fmt --all` and `git diff --check` — passed.
- Chat-primitives red phase: the new focused tests failed because `unread_snapshot`, transcript checkpointing, browser-answer persistence, and independent automation offline claims did not exist.
- Chat-primitives verification to date:
  - `cargo test --lib markdown_chat::storage` — 10 passed;
  - `cargo test --test markdown_chat --test markdown_chat_tools --test markdown_chat_timestamps` — 38 passed, 1 environment-gated Apprise test ignored;
  - `cargo clippy --lib -- -D warnings` — passed;
  - `cargo fmt --all` and `git diff --check` — passed.
- Task 5 red phase: `cargo test --test agent_automation_tools` failed on the
  placeholder schemas, missing request-context fields, absent goal results,
  unconsumed pairing mismatches/expiry, and absent brief guidance.
- Task 5 targeted green phase:
  - `cargo test --test agent_automation_tools` — 11 passed;
  - `cargo test --test agent_automation_store` — 8 passed.
- Cross-project pairing-index red/green phase: the new mismatch test first failed
  because pairing references could only resolve within one project-state root;
  `pairing_mismatch_across_project_state_roots_consumes_the_reference` now passes
  with the private shared digest index.
- Server-dispatch verification now proves `automation_verify_pairing` cannot bypass
  the ordinary per-conversation setup gate, does not consume its reference while
  unauthorized, and receives owner generation zero from the live request-context
  path after authorization.
- Task 5 broad verification:
  - `cargo clippy --all-targets -- -D warnings` — passed;
  - `cargo test --lib` — 582 passed;
  - `cargo test --test agent_automation_store --test agent_automation_tools --test markdown_chat_tools --test tools_core --test meta_suite` — 107 passed, 1 environment-gated Apprise test ignored;
  - `cargo fmt --all --check` and `git diff --check` — passed.
- A focused owner-generation test now proves a pairing issued for an older
  continuation generation is rejected and consumed rather than being silently
  rebound to the new physical owner.
- The pairing-reference index now has dedicated privacy and unsafe-path
  coverage: its directory is private, records are private, filenames are SHA-256
  digests, raw references are absent, and unsafe roots fail closed.
- Task 5 now passes the complete library suite and all directly affected
  integration suites; the aggregate diff was reviewed in the Codexify diff widget.

## Current checkout state

- Branch: `feat/agent-chat-browser-automation`
- HEAD: `27a0d9b`
- Working tree: clean before this progress-only update.
- Next step: complete Task 5 with red-green tool and dispatch tests, commit it,
  then add the authenticated companion client and global offline supervisor.
