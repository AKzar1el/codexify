# Agent Chat Browser Automation Progress

**Last updated:** 2026-10-10

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
- Task 6 red phase: `cargo test --test agent_automation_companion` failed because no companion protocol types or client existed.
- Task 6 first green phase: `cargo test --test agent_automation_companion` — 6 passed.
- A focused owner-generation test now proves a pairing issued for an older
  continuation generation is rejected and consumed rather than being silently
  rebound to the new physical owner.
- The pairing-reference index now has dedicated privacy and unsafe-path
  coverage: its directory is private, records are private, filenames are SHA-256
  digests, raw references are absent, and unsafe roots fail closed.
- Task 5 now passes the complete library suite and all directly affected
  integration suites; the aggregate diff was reviewed in the Codexify diff widget.
- Committed the complete Task 5 slice as `2220b1f` (`feat: add agent automation MCP tools`).
- Resumed the task by rereading the complete 1,336-line revised architecture, this
  progress journal, and the complete 13-task implementation plan before touching
  the uncommitted Task 6 slice.
- Task 6 is complete:
  - the client loads and validates a private descriptor, live PID, IPv4-loopback
    endpoint, protocol/build identity, and high-entropy bearer without exposing
    the bearer, endpoint, prompts, or private response data in Debug/errors;
  - HTTP uses no proxies or redirects, bounded JSON bodies, cancellation, request
    deadlines, and a separately bounded event-stream idle deadline;
  - health, login, capabilities, reveal, execute, cancel, action-state, and NDJSON
    event APIs are implemented with strict response validation;
  - execute ambiguity reconciles the exact action ID before any retry and never
    invents a replacement action after possible Send acceptance;
  - event streams enforce content type, total/line/delta bounds, action identity,
    strictly increasing sequence numbers, typed terminal states, and cancellation.
- Task 6's final red-green addition proved that a companion which emits a
  nonterminal event and then stalls is terminated by the client-specific idle
  deadline rather than hanging indefinitely.
- Committed Task 6 as `25dcde5` (`feat: add browser companion protocol client`).
- Task 7 has started with strict TDD. The first red test failed because the global
  supervisor, task registration, executor abstraction, and selection mutation did
  not exist. The minimal green slice now registers task handles, reads the existing
  persisted activity clock, and proves that unread messages remain entirely on the
  ordinary path while the task is still online; no queue entry, mirror state, or
  companion call is created.
- The second Task 7 red/green slice now queues an offline unread-message action
  without requiring a goal. It snapshots the existing non-consuming unread records,
  builds a deterministic batch identity plus fresh action/idempotency IDs, persists
  the queued action state, and leaves the `CHAT.md` read cursor untouched.
- The third Task 7 slice now executes a goal-only action through the executor
  abstraction, records the accepted nudge against the persisted activity epoch, and
  marks the active goal's automation state `stalled` when the accepted browser turn
  produces no new model-visible Codexify tool activity. The independent persistent
  offline claim prevents another automatic nudge in the same epoch.
- The fourth Task 7 slice records accepted unread batches without acknowledging
  them. Accepted message IDs and the batch/revision receipt are persisted only
  after semantic Send acceptance, the ordinary chat cursor remains unchanged, and
  later scans exclude those still-unread IDs so the same owner message is not
  mirrored automatically twice.
- The fifth Task 7 slice coalesces additional unread messages into an unsent action
  for the same task, preserving the original action/idempotency identity while
  recomputing the bounded batch payload. Queue ordering is now explicit:
  pair-verification first, unread/combined work next, and goal-only work last.
- Browser output persistence now has direct supervisor coverage: a stable final
  answer is appended exactly once when the model did not use `chat_write`, while an
  agent block written during the browser turn suppresses the fallback transcript
  append. The browser final remains available only as bounded automation diagnostics
  in that race.
- Queued actions now carry immutable URL, owner-generation, account, catalog,
  model, effort, and goal-revision snapshots. A changed selection invalidates the
  old unsent action and creates a fresh action/idempotency identity rather than
  mutating the old one in place. Queue overload leaves all chat input unread and
  records a bounded task-local failure for the standalone UI.
- Ambiguous accepted Sends now consume both sides of a combined action's replay
  budget: unread message IDs are persisted as mirrored and the goal activity epoch
  is recorded/claimed. The action remains `ambiguous`, the user input remains
  unread, and neither the chat batch nor a derived goal-only wake is emitted again
  automatically.
- Companion events are now consumed concurrently with execution rather than only
  after the action returns. Bounded transient status, commentary, and answer state
  is queryable per stable task while generation is still running, but no delta is
  written to `CHAT.md`; only the settled stable final participates in fallback
  persistence.
- A production `BrowserAutomationExecutor` now wraps the authenticated companion
  client. Immediately before any physical Send it rechecks login/idle state,
  account fingerprint, catalog revision, exact model, and exact available effort;
  it streams the bounded event contract, reconciles the exact action after stream
  failure, and never substitutes a model, account, or action identity.
- Explicit pair-verification actions are now a first-class queue operation with the
  highest priority. They revalidate the one-time reference without consuming it,
  carry no chat/goal content, accept an unverified candidate URL, and record the
  companion's canonical URL before normal pairing verification can complete. Pair
  output is operational only and never enters `CHAT.md`.
- The supervisor now has one long-lived background worker. Registration and explicit
  queue operations wake it immediately; otherwise it rescans the shared task set at
  a bounded interval, drains one global action at a time, logs task-local failures,
  and continues to the next queued task.
- Resumed again by rereading the complete 1,336-line revised architecture, this
  progress journal, and the complete 13-task execution plan before reviewing the
  uncommitted Task 7 implementation.
- The existing 16 supervisor tests passed, but the review found six uncovered
  fail-closed requirements. New red tests now prove the current implementation:
  - retries unchanged pre-Send failures automatically;
  - replays a persisted in-flight action after supervisor restart;
  - queues more than the protocol's 128-message limit and accepts one message over
    the 256 KiB browser-prompt ceiling instead of failing it intact;
  - lets a stale high-priority action block the next ready action;
  - accepts a terminal snapshot whose canonical conversation differs from the exact
    paired URL.
- The six review regressions are now green:
  - unchanged pre-Send failures and persisted in-flight actions block automatic
    replay while ordinary chat remains usable;
  - unread batches are capped at 128 messages and 256 KiB without truncating a
    message, with an explicit task-local failure for a single oversized message;
  - stale queued heads are skipped so later ready work continues in the same drain;
  - non-pair actions require the companion's terminal canonical URL to equal the
    exact paired conversation;
  - goal-only deduplication now uses the persisted activity epoch only after Send
    acceptance, rather than consuming the epoch merely by entering the queue.
- Task 7 is now implementation-complete for its planned Rust boundary. The server
  owns one shared supervisor/worker, registers stable tasks from model-visible
  activity, serializes one global queue, revalidates immutable execution snapshots
  immediately before Send, and leaves online/manual agent chat unchanged.
- Committed Task 7 as `b1d2daa` (`feat: supervise offline browser chat actions`).
- Task 8 has started: add the authenticated standalone owner-chat automation API,
  exact local `/goal` command parsing, and standalone-only controls without exposing
  companion credentials or browser controls to the embedded ChatGPT widget.
- Task 8's first slice is green:
  - `/goal set`, `run`, `stop`, `clear`, and `status` are parsed locally and
    `//goal` escapes to an ordinary chat message;
  - mutating goal commands use a private bounded request ledger so response-loss
    retries do not create a second goal revision or repeat a lifecycle transition;
  - goal commands never enter `CHAT.md`, while literal escaped messages still do;
  - the authenticated standalone automation-state endpoint exposes pairing,
    selection, goal, action, live-output, and presence state without descriptor,
    bearer-token, or companion-endpoint data;
  - owner-state lookup registers the stable task with the existing supervisor and
    binds pairing validity to the continuation owner generation.
- Resumed Task 8 after exhaustively rereading the complete 1,336-line approved
  architecture and this full progress journal. The saved handoff and checkout agree:
  the backend owner-management slice is uncommitted, and the next work is the
  remaining authenticated action controls plus standalone-only browser UI.
- Task 8's standalone UI red-green slice is now green in Chromium and WebKit:
  - automation controls are created only by the standalone owner page after its
    authenticated automation-state endpoint reports `enabled=true`;
  - the panel exposes companion/login, capability refresh, exact URL pair/replace,
    unlink/reveal, model/effort filtering, goal set/run/stop/clear/status, queue and
    presence badges, task-local errors, and live status/commentary/answer output;
  - every browser operation goes through Codexify's owner API, while local goal
    commands continue through the existing `/send` endpoint and remain absent from
    transcript history;
  - disabled automation leaves the existing standalone chat layout and behavior
    intact, and the new panel remains usable without horizontal overflow at the
    mobile test viewport.
- Completed the standalone action-repair slice:
  - owner state now exposes the exact one-based queue position and total without
    exposing queued prompt contents;
  - the authenticated owner API provides bounded action status, queued-action
    cancellation, and explicit retry for actions proven to have failed before
    Send;
  - cancelling queued pairing verification revokes the one-time reference and
    returns the task to `unpaired` rather than leaving an unreplayable pending
    handshake;
  - ordinary queued cancellation preserves unread chat and active-goal state,
    records a blocking pre-Send failure, and requires explicit retry;
  - retry rejects ambiguous/accepted actions and pairing verification, clears only
    the failed action envelope, revalidates current task state, and rebuilds a new
    queue entry through the normal supervisor scan;
  - a terminal browser failure after semantic Send acceptance is now normalized to
    `ambiguous`, so explicit retry cannot duplicate an accepted message;
  - standalone controls expose Cancel queued action and Retry failed action, while
    the embedded ChatGPT widget remains free of clipboard and browser controls.

## Current checkout state

- Branch: `feat/agent-chat-browser-automation`
- HEAD: `5d9be86`
- Working tree: the Task 8 backend owner-management slice is uncommitted across
  owner chat, persistent automation state, continuation-generation lookup, server
  wiring, and this progress journal.
- Next step: verify that backend slice, add explicit action status/cancel/retry
  behavior under TDD, then render companion, URL, model/effort, goal, queue, error,
  and live-output controls only in the standalone page.

## Latest verification

- Task 6 red phase: the event-idle test failed because the client had no
  independently configurable event-stream idle timeout.
- Task 6 green verification:
  - `cargo test --test agent_automation_companion` — 13 passed;
  - `cargo clippy --test agent_automation_companion -- -D warnings` — passed;
  - `cargo fmt --all --check` and `git diff --check` — passed.
- Task 7 first red/green slice:
  - red: `cargo test --test agent_automation_supervisor online_unread_messages_never_enqueue_or_call_the_companion -- --exact` failed on the missing supervisor API;
  - green: the same test passed after adding the minimal supervisor/task/executor
    surface and task-scoped selection mutation.
- Task 7 offline-chat slice:
  - red: `offline_unread_messages_enqueue_without_a_goal_and_remain_unread` failed
    with an empty queue;
  - green: the same test passed with one persisted `offline_chat` action and the
    original message still unread.
- Task 7 goal-only slice:
  - red: `goal_only_action_runs_once_per_activity_epoch_and_stalls_without_tool_activity`
    failed because the supervisor had no execution path;
  - green: the action ran exactly once, emitted the fixed `offline_goal` prompt,
    persisted `stalled`, drained the queue, and did not requeue in the same activity
    epoch.
- Task 7 unread-deduplication slice:
  - red: `accepted_unread_batch_is_not_acknowledged_or_automatically_mirrored_twice`
    found no persisted mirror receipt;
  - green: the batch receipt and message ID were persisted after Send acceptance,
    the message remained unread, and the same epoch did not queue it again.
- Task 7 coalescing/priority slices:
  - red: a second message appended before execution was absent from the queued
    browser prompt;
  - green: the single queued action contained both stable message IDs;
  - red: no queue-introspection/priority contract existed;
  - green: cross-task unread work is ordered ahead of goal-only continuation work.
- Task 7 output-persistence regression coverage:
  - stable browser final without `chat_write` is persisted exactly once;
  - racing `chat_write` output remains authoritative and suppresses the duplicate
    browser final from `CHAT.md`.
- Task 7 invalidation/capacity slices:
  - red: changing effort/catalog reused the queued action ID;
  - green: the stale action was removed and a fresh identity carried the new
    selection;
  - red: queue exhaustion silently skipped the second task;
  - green: exactly one task is queued at capacity one, the other records a bounded
    queue-capacity failure, and both transcripts remain unread.
- Task 7 ambiguous-Send slice:
  - red: a combined ambiguous Send preserved the chat batch but left the goal epoch
    re-armable;
  - green: the same epoch is fully fenced and no follow-up action is queued.
- Task 7 live-stream slice:
  - red: no task-scoped live state existed and event consumption waited for the
    executor to return;
  - green: status/commentary/answer deltas are visible during the blocked fake turn,
    remain absent from the transcript, and only the complete answer is persisted at
    terminal settlement.
- Task 7 production-executor slice:
  - red: the production executor did not exist;
  - green: a local authenticated companion fixture proves an account mismatch stops
    before capabilities/execute and is classified as pre-Send.
- Task 7 pair-verification slices:
  - red: no explicit pair queue operation existed;
  - green: pair verification outranks pending unread work and persists a queued
    `pair_verify` action;
  - red: an unverified pair action failed ordinary offline/verified-URL eligibility;
  - green: it executes against the exact pending reference, records the canonical
    URL, remains `unverified` until the MCP proof arrives, and leaves chat empty.
- Task 7 worker slice:
  - red: no supervisor lifecycle or wake API existed;
  - green: a notified, already-offline task is scanned and executed by the single
    background worker, which is aborted when its server-owned guard is dropped.
- Task 7 review red phase: `cargo test --test agent_automation_supervisor` ran 22
  tests; 16 passed and the six new fail-closed regression tests failed for the
  expected missing behavior listed above.
- Task 7 review green phase: `cargo test --test agent_automation_supervisor` — 22
  passed.
- Final Task 7 verification after the review fixes:
  - `cargo test --test agent_automation_supervisor --test agent_automation_companion --test agent_automation_store --test agent_automation_tools` — 55 passed;
  - `cargo test --lib` — 583 passed;
  - `cargo clippy --all-targets -- -D warnings` — passed;
  - `cargo fmt --all` and `git diff --check` — passed.
- Task 8 first-slice verification:
  - red: parser and owner API tests failed before local command dispatch, persistent
    idempotency, owner automation context, and the automation-state route existed;
  - green: `cargo test --lib owner_chat::tests` — 9 passed, including exact command
    parsing, lifecycle, replay, transcript isolation, authentication, and state
    redaction checks.
- Task 8 standalone UI red phase: the new Chromium/WebKit owner-page test failed
  waiting for `#automation-panel`, proving no browser controls existed yet.
- Task 8 standalone UI green phase: `node --test scripts/test-owner-chat.mjs` — 4
  passed across Chromium and WebKit, covering disabled isolation, authenticated
  owner API routing, capability filtering, pairing, goals, live output, queue state,
  secret absence, and mobile layout.
- Action-repair red phases:
  - owner queue-state test observed `null` before queue positions were exposed;
  - store retry test failed because no explicit failed-action reset existed;
  - supervisor tests failed because queued cancellation and explicit retry were
    absent;
  - accepted terminal failure remained `failed` instead of fail-closed `ambiguous`.
- Action-repair green verification:
  - targeted store retry test passed;
  - targeted supervisor retry, pairing-cancel, and accepted-failure tests passed;
  - targeted authenticated owner action API tests passed, including unread-message
    preservation;
  - `node --test scripts/test-owner-chat.mjs` — 4 passed on Chromium and WebKit;
  - embedded-widget isolation test passed on Chromium and WebKit through the
    targeted Markdown-chat widget test.
- Task 8 aggregate verification is green:
  - `cargo test --lib owner_chat::tests` — 11 passed;
  - `cargo test --test agent_automation_store` — 9 passed;
  - `cargo test --test agent_automation_supervisor` — 28 passed;
  - combined owner-chat and Markdown-chat browser suite — 114 passed across
    Chromium and WebKit;
  - `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all`, and
    `git diff --check` passed.
- Preserved the public three-argument `owner_chat::start` integration surface and
  moved server-only continuation/supervisor injection behind
  `start_with_automation`; this fixed the restart integration target without
  weakening the production wiring.
- `cargo test --test owner_chat_restart` also passed after preserving that public
  startup surface (1 passed, its subprocess fixture remained intentionally ignored).
- Committed the complete Task 8 owner API/UI and action-repair slice as `c013069`
  (`feat: add standalone chat browser automation controls`). The working tree was
  clean at the Task 9 boundary.
- Task 9 is now active: extract the approved narrow browser/session layer from
  upstream `f9ad4ae` into a one-window TypeScript/Electron companion, retain MIT
  attribution and update tooling, and exclude every Responses/Codex/multi-tab
  subsystem named as a non-goal.
- Task 9 scaffold is in place:
  - added an independently typechecked/tested Bun package under
    `browser-companion/` with the exact upstream browser dependencies plus
    Electron for the persistent user-session process;
  - copied the upstream MIT license, added the third-party notice and an explicit
    source-boundary document naming tag `v6.1.7` / commit `f9ad4ae`;
  - copied the upstream session/model-selector and stable Markdown modules as the
    structural starting point rather than rewriting their selector and streaming
    logic from memory;
  - installed the pinned package graph and generated `browser-companion/bun.lock`.
- Task 9 initial red phase: `bun test` ran the copied session and Markdown tests
  successfully (8 passed) and failed exactly because the new fixed protocol,
  model-catalog, and composer modules did not yet exist (3 missing-module errors).
- Task 9's first companion-core slice is green:
  - implemented strict protocol-v1 request, response, event, descriptor, URL, size,
    and opaque-ID contracts matching the existing Rust client;
  - implemented fixed pair/unread/goal prompt rendering with unread Markdown escaped
    as data and no arbitrary browser-code surface;
  - implemented stable Luna, GPT-5.6 Sol, and GPT-6 Sol capability IDs plus live
    effort availability and deterministic privacy-preserving catalog revisions;
  - extracted upstream exact-composer insertion, session selectors, model-family
    verification, and stable incremental Markdown conversion with source comments;
  - `bun test` for protocol, models, composer, session, and response streaming now
    passes 21 tests with 73 assertions.
- Added the task-independent single-window orchestration core:
  - exact stable turn identities and semantic Send evidence are adapted from the
    upstream grouped/legacy DOM model rather than display-index heuristics;
  - the companion accepts one active action globally, rejects navigation for a
    second task while generation is active, and makes execute/cancel idempotency
    explicit;
  - action history is exposed as bounded ordered NDJSON-ready events, with
    accepted cancellation normalized to `ambiguous_send` and no automatic replay;
  - `bun test` for turn binding and single-window coordination passes 7 additional
    tests, and the complete companion package typechecks cleanly.
- Completed the first runnable companion implementation:
  - added privacy-preserving ChatGPT account projection/fingerprinting, exact
    connector selection and cleanup, Luna/Sol family plus effort verification,
    semantic Send acceptance, stable assistant-turn reconciliation, visible
    status/commentary/answer streaming, and fail-closed approval/auth/rate-limit/
    interference handling;
  - added one persistent Electron `BrowserWindow` with a private profile, loopback
    CDP attachment, HTTPS-only navigation, hide-on-close behavior, and explicit
    reveal/action ownership;
  - added the authenticated loopback protocol server, strict bounded JSON and
    NDJSON event endpoints, high-entropy bearer token, private atomic descriptor,
    symlink/type/mode rejection, and owned descriptor cleanup;
  - companion preflight now refuses queue ownership before navigation when the
    shared ChatGPT window is already generating, waiting for approval, holding a
    user draft, logged out, or otherwise unavailable;
  - control-server shutdown aborts an active action before waiting for its NDJSON
    client, preventing a service-stop deadlock while preserving accepted actions as
    ambiguous rather than replayable;
  - added a single-instance Electron entry point and reproducible Bun bundle.
- Added `upstream-manifest.json` plus
  `scripts/update-browser-companion-upstream.mjs`: it verifies the exact upstream
  commit, produces whole-file adaptation diffs and derived-symbol anchors, and
  prevents copied modules from silently losing their provenance.
- Added a source-boundary regression test proving that the package has exactly one
  browser window and imports no upstream Responses, Codex-provider, tunnel,
  subagent, retained-conversation, or multi-tab pool subsystem.
- Task 9 aggregate verification:
  - `bun test` — 40 passed, 0 failed, 166 assertions across 12 companion test files;
  - `bun run typecheck` — passed under strict TypeScript settings;
  - `bun run build` — bundled the Electron entry (145.98 KiB, external Electron and
    Playwright dependencies);
  - `node --test scripts/test-browser-companion-boundary.mjs` — 4 passed;
  - `node scripts/update-browser-companion-upstream.mjs --source
    /tmp/codex-chatgpt-web-v6.1.7 --check` — passed at exact commit `f9ad4ae`.
- Committed the complete single-window companion extraction as `0b9052d`
  (`feat: add single-window ChatGPT browser companion`).
- Task 10 is now active: exercise the real TypeScript protocol server through the
  Rust `BrowserCompanionClient`, then add restart/cancellation/build-mismatch
  contract coverage before lifecycle packaging.
- Completed the Rust↔TypeScript protocol contract:
  - added a checked-in canonical protocol-v1 schema and SHA-256 build binding;
    descriptors and every response now require a build suffix tied to those exact
    schema bytes, so a self-consistent but incompatible companion is rejected;
  - added generated golden JSON covering descriptor, health, capabilities,
    reveal, all four prompt kinds, action snapshots, cancellation, and every event
    variant; strict TypeScript parsing and Rust serialization/deserialization both
    consume the same fixtures;
  - the real TypeScript fixture server is now exercised through the Rust HTTP
    client for health, login, capabilities, reveal, execute, status, ordered NDJSON
    events, idempotent replay, accepted cancellation, build mismatch, and companion
    restart;
  - the cross-language test exposed that nested Rust prompt fields were serialized
    as `batch_id`/`goal_revision`; the wire contract now correctly uses camelCase
    throughout, with a dedicated regression test;
  - accepted cancellation remains `ambiguous` across the real process boundary and
    cannot be converted into a replayable failed action after restart.
- CI now installs pinned Bun 1.4.0, regenerates and diff-checks fixtures, verifies
  the upstream extraction boundary, tests/typechecks/builds the companion, runs the
  source-boundary checks, and executes all ignored Rust↔TypeScript contract tests.
- Task 10 verification:
  - Rust fake-companion suite — 14 passed;
  - Rust golden fixture suite — 2 passed, with the 3 Bun-backed process tests
    explicitly gated from ordinary Cargo runs;
  - Bun-backed Rust process suite — 3 passed;
  - companion suite — 43 passed, 0 failed, 183 assertions;
  - companion typecheck and build passed (146.83 KiB bundle);
  - CI workflow contract test passed.
- Committed the pinned cross-language protocol contract as `f8abcc4`
  (`test: pin browser companion protocol contract`).
- Task 11 is now active: add explicit browser-companion lifecycle commands,
  versioned/checksummed installation, doctor states, user-session launch handling,
  package smoke tests, and release/installer integration without changing ordinary
  installations when automation is disabled.
- Resumed Task 10 after exhaustively rereading the complete 1,336-line approved
  architecture, this full progress journal, and the complete 13-task execution
  plan. The checkout contains an uncommitted protocol-contract slice: a checked-in
  protocol schema/hash, generated golden fixtures, Rust and TypeScript parsers,
  and a cross-process Bun fixture server. The next step is to run the focused
  contract suites, identify the remaining red cases, and complete restart,
  cancellation, bounds, authentication, and build-mismatch coverage before the
  Task 10 commit.
- Task 10 focused verification began:
  - TypeScript golden-contract tests pass (3 tests, 17 assertions) and strict
    typechecking passes;
  - Rust golden-fixture parsing passes;
  - the real Bun server round-trip and accepted-action cancellation tests pass;
  - the restart contract is red only because its assertion expected a literal
    `not found` string while the strict Rust client intentionally maps the 404 to
    the bounded redacted error `Browser companion resource is unavailable`.
- Resumed at the committed Task 10 boundary (`f8abcc4`) and exhaustively reread the
  complete 1,336-line revised architecture plus this complete progress journal.
  Task 11 is the active implementation boundary: lifecycle CLI, private versioned
  installation, checksum verification, user-session process control, doctor
  diagnostics, package smoke tests, and opt-in release/installer integration.
- Completed the Task 11 surface audit:
  - no browser lifecycle/install module or CLI command family existed;
  - doctor had no companion-specific state check;
  - CI tested and bundled source but did not package or smoke-test an installed app;
  - release workflows and installers carried only the Codexify server artifacts.
- Task 11 CLI red-green slice:
  - red: focused config tests failed because `CliCommand::Browser` and
    `BrowserCommand` did not exist;
  - green: `codexify browser install|start|stop|status|login|reveal` now parses,
    including `browser status --json` with global config arguments;
  - both focused parser tests pass.
- Task 11 private-runtime red-green slice:
  - red: a new integration target failed because no browser release asset,
    versioned runtime layout, checksum verifier, manifest validator, or installer
    existed;
  - green: the lifecycle module now selects the exact platform asset for the current
    Codexify version, verifies one exact SHA-256 entry, safely extracts bounded
    tar/ZIP packages, rejects unsafe paths and incompatible manifests, and publishes
    atomically under `~/.codexify/browser/runtime/<version>/` with private modes;
  - disabled automation refuses installation before creating browser state;
  - status distinguishes disabled, missing, stopped, authentication-required,
    account-changed, busy, ready, incompatible, and unavailable states without
    returning account fingerprints or companion credentials;
  - `cargo test --test browser_companion_install` — 4 passed.
- Resumed from the uncommitted Task 11 lifecycle handoff after rereading the full
  1,336-line revised architecture and this complete progress journal. The current
  lifecycle/install implementation was audited rather than assumed complete.
- Focused Task 11 verification is green:
  - `cargo test --test browser_companion_cli` — 2 passed;
  - `cargo test --test browser_companion_install` — 6 passed, including the real
    detached user-process start/login/reveal/stop fixture;
  - the focused CLI parser tests and the doctor lifecycle-state mapping test each
    pass.
- Task 11 status-read red-green slice:
  - red: a legacy-config integration test proved that `browser status` used the
    mutating config loader and silently persisted a schema migration plus backup;
  - green: status now uses the read-only quiet loader, while lifecycle mutations
    retain the normal migration path; the focused integration test passes and the
    config bytes remain unchanged.
- Task 11 process-ownership red-green slice:
  - red: a stale but private descriptor whose PID had been reused for an unrelated
    process allowed `browser stop` to signal that PID without proving the
    authenticated loopback companion still answered;
  - green: stop now requires a bounded authenticated health response and exact
    build before signalling the descriptor PID; the regression leaves the
    unrelated process alive and the full install/lifecycle suite passes 7 tests.
- Cross-language contract repair completed before packaging continued:
  - red: the committed Rust client rejected TypeScript-valid 256-code-unit model
    and effort labels, 1 KiB effort reasons, 64 KiB attention messages, and a valid
    request whose JSON escaping exceeded the old ad-hoc prompt-plus-slack limit;
  - red: NUL-containing unread Markdown and XML-escaped prompt expansion reached
    the fake companion instead of failing before network access;
  - green: Rust now applies the protocol's 1 MiB JSON bound, exact visible-text and
    delta bounds, NUL rejection, and the same fixed XML-escaped prompt rendering
    used by the TypeScript companion; `agent_automation_companion` passes 17 tests.
- Task 11 lifecycle/diagnostic aggregate verification is green:
  - browser CLI integration — 3 passed;
  - browser install/lifecycle integration — 7 passed;
  - Rust companion protocol integration — 17 passed;
  - checked-in protocol fixtures — 2 passed, with 3 real-Bun tests intentionally
    gated for explicit CI execution;
  - doctor-focused library suite — 17 passed;
  - `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all --check`, and
    `git diff --check` passed.
- Task 11 packaging contract red-green slice:
  - red: the companion had no package builder, artifact manifest, packaged smoke
    path, or package smoke launcher;
  - green: the package now pins electron-builder 26.15.3, emits one native
    versioned `codexify-browser-v<version>-<platform>` archive with the protocol
    hash/build manifest expected by the Rust installer, dereferences packaged app
    symlinks for the fail-closed extractor, and provides an Electron readiness-only
    smoke path that never opens ChatGPT or starts the control server;
  - the focused packaging contract passes 2 tests with 17 assertions.
- Packaged-runtime smoke red-green slice:
  - red: the first macOS archive converted framework links into absolute build-path
    symlinks, so the extracted application could not load Electron Framework;
  - green: packaging preserves original relative app links, while the Rust tar
    extractor now accepts only bounded relative symlinks whose lexical target stays
    inside the versioned package root and continues to reject absolute/escaping
    links;
  - the native darwin-arm64 artifact now launches its packaged Electron readiness
    path successfully, reports the exact protocol-bound build, exits without
    opening ChatGPT or publishing a descriptor, and passes
    `PACKAGED_BROWSER_COMPANION_SMOKE_OK darwin/arm64`.
- Installer opt-in red-green slice:
  - red: the release installers never invoked the new browser lifecycle even when
    explicitly requested;
  - green: `CODEXIFY_INSTALL_BROWSER=1` now requires an existing valid config and
    delegates the verified optional artifact install to
    `codexify --config <path> browser install`; the default remains zero browser
    downloads/processes and unsupported values fail before installation;
  - the POSIX installer syntax and full replacement/checksum/PATH/service/browser
    integration test pass. The equivalent Windows fixture now records and requires
    exactly one opt-in browser install for its platform CI run.
- Release publication red-green slice:
  - red: release orchestration expected only the five Codexify server archives and
    therefore omitted every browser companion artifact from checksums/publication;
  - green: release staging now requires and checksums the five server archives plus
    five version-matched browser companion archives, publishes the exact combined
    set, and keeps notarization/signature checks scoped to the existing Codexify
    macOS executable submissions;
  - release CI now builds all five browser platforms, smoke-runs native
    linux-x64/darwin-arm64/windows-x64 packages, uploads exact artifact names, and
    gates release staging on the browser matrix;
  - the complete release-notarization suite passes 30 tests and the focused CI
    workflow contract passes.
- Release cache/contract hardening is green:
  - release validation now runs the real ignored Rust↔TypeScript companion process
    contract with the pinned Bun executable before any artifact can publish;
  - the default-branch cache warmer saves Bun, Electron, and electron-builder
    download caches for all five browser package targets, while release-tag jobs use
    restore-only cache access;
  - all 9 workflow contract tests pass and all three edited workflow files parse as
    valid YAML.
- Resumed from the Task 11 packaging handoff after exhaustively rereading the full
  1,336-line revised architecture, this complete progress journal, and the complete
  execution plan. The worktree contains the uncommitted package/build, installer,
  release, and cache integration slice described above; the next step is a fresh
  focused verification and aggregate review before committing it.
- Fresh companion packaging/protocol verification is green:
  - `git diff --check` passed;
  - targeted Bun packaging and protocol suites passed 16 tests with 74 assertions;
  - strict TypeScript typechecking passed.
- Focused Rust verification found one stale golden-test constructor: the generated
  protocol fixture now uses a valid 43-character pairing reference, while the Rust
  comparison still serialized the old placeholder. The failing exact test reproduced
  the mismatch; updating that test datum to the canonical fixture value made
  `rust_shapes_match_every_golden_protocol_fixture` pass.
- The refreshed Task 11 Rust/CI/doctor matrix is green:
  - companion protocol integration — 17 passed;
  - browser lifecycle CLI — 3 passed;
  - checked-in protocol fixtures — 2 passed, with 3 real-Bun tests explicitly gated;
  - browser install/lifecycle integration — 8 passed, including safe relative tar
    symlinks and the detached user-process fixture;
  - workflow contracts — 9 passed;
  - doctor-focused library tests — 17 passed.
- Fresh native package verification is green on macOS arm64: electron-builder
  produced `codexify-browser-v1.7.0-darwin-arm64.tar.gz`, and the extracted packaged
  readiness path returned `PACKAGED_BROWSER_COMPANION_SMOKE_OK darwin/arm64` without
  opening ChatGPT or publishing a companion descriptor.
- Installer and release orchestration verification is green on the available host:
  - POSIX installer syntax and the full fake-release integration suite passed,
    including the explicit browser opt-in path;
  - the release/notarization orchestration suite passed all 30 tests with the exact
    combined server-plus-browser asset set;
  - PowerShell was unavailable on this macOS host, so the Windows installer fixture
    remains covered by its dedicated Windows CI job rather than a local execution.
- Package-attribution review found that the first native artifact contained the app
  and runtime manifest but omitted Codexify's license, the third-party notice, and
  the vendored upstream MIT text. A focused packaging-contract test failed first;
  the packager now includes `LICENSE`, `THIRD_PARTY_NOTICES.md`, and
  `LICENSES/codex-chatgpt-web-MIT.txt`, and the packaged smoke path verifies all
  three. The focused test is green with 2 tests and 23 assertions.
- The complete companion suite remains green after the attribution fix: 49 tests,
  216 assertions, and strict TypeScript typechecking passed. A fresh native
  darwin-arm64 package also smoke-tested successfully, and direct archive inspection
  confirmed all three notice files are present at the package root/license path.
- Installer mirror propagation review found that an opt-in install using
  `CODEXIFY_RELEASE_ROOT` downloaded the Codexify binary from that mirror but let the
  delegated browser installer fall back to GitHub. The POSIX fixture failed first;
  both installers now pass the selected release root through
  `CODEXIFY_BROWSER_RELEASE_ROOT` unless the user explicitly supplied a browser-only
  override. POSIX syntax and the complete installer fixture are green again; the
  Windows fake executable enforces the same contract in its platform CI run.
- Task 11 formatting and static analysis are green after applying the one rustfmt
  layout change reported by the initial check: `cargo fmt --all` completed and
  `cargo clippy --all-targets -- -D warnings` passed.
- The protocol fixture regenerated to the checked-in hash
  `edc90b30a9de09b1e992d4384ac1df24b08e4a98d8e52687a2542dee561877b2`,
  `git diff --check` remains clean, all four browser-companion source-boundary tests
  pass, and the upstream extraction check still matches exact commit `f9ad4ae`.
- Committed the complete Task 11 package/lifecycle/release slice as `2068881`
  (`feat: package agent chat browser companion`). Task 12 is now active: document
  the operator and security model, complete redaction/audit coverage, and record the
  opt-in migration and live-test limitations before final aggregate verification.
- Task 12 privacy hardening is in progress under TDD:
  - new red tests proved generic JSON payload redaction exposed paired ChatGPT URLs,
    browser prompts/output, goal Markdown, mirrored messages, and pairing state;
  - the redactor now treats those automation-specific keys as sensitive while
    preserving nonprivate operational status;
  - `goal_finish` summary/reason inputs are now write-only in the advertised schema,
    and every `goal_read`/`goal_finish` result suppresses its complete payload preview;
  - tool logging now uses the generic `<private tool output>` placeholder and focused
    request/response tests prove goal text and blocked reasons never enter previews;
  - focused redaction and goal/tool-logging tests are green.
- Documentation is now being driven by an integration contract across README,
  REFERENCE, ARCHITECTURE, CHANGELOG, the example config, and third-party notices.
  The contract first failed on the missing user-facing browser-fallback section;
  those operator, lifecycle, pairing, queue, goal, failure, security, and migration
  explanations have now been added and await the focused documentation rerun.
- Task 12 documentation and browser-error privacy are now green in focused tests:
  - the cross-document integration contract passes after adding user, operator,
    architecture, release-note, lifecycle, pairing, queue, goal, and fail-closed
    guidance;
  - an audit-shape test confirms candidate URLs, pairing references, prompts, goal
    text, and account fingerprints never enter audit values;
  - a new companion test first reproduced raw Playwright/page failure text crossing
    the protocol, including a paired URL and prompt excerpt; unknown failures now
    map to a generic operational error, controlled companion errors keep their
    bounded message, and dynamic health/model/ambiguous-Send wrappers no longer
    forward arbitrary underlying text;
  - the focused companion error tests and strict TypeScript typecheck pass.
- Control-server error redaction is now covered independently: a real authenticated
  fixture first returned raw capability/reveal failures containing a paired URL,
  page text, and browser prompt; non-protocol internal failures now pass through the
  companion's public error boundary before HTTP serialization. All four control
  server tests (30 assertions) and strict TypeScript typechecking pass.
- Task 12 aggregate privacy/documentation verification is green:
  - redaction-focused tests — 9 passed;
  - audit-focused tests — 18 passed;
  - tool-logging-focused tests — 18 passed;
  - complete skills/documentation suite — 104 passed;
  - agent automation tool integration — 11 passed.
  These runs cover automation-specific private keys, write-only goal completion
  arguments, private goal outputs, audit shape-only retention, generic companion
  failures, the cross-document contract, and unchanged pairing/goal behavior.
- A broader owner-chat rerun exposed one stale test descriptor build that predated
  the protocol-schema suffix. Updating that fixture to the current exact
  protocol-bound build restored the credential-isolation API test. The complete
  owner-chat library suite (11), agent-automation tool suite (11), and
  skills/documentation suite (104) now pass together.
- Task 12 final static verification is green: `cargo fmt --all --check`,
  `cargo clippy --all-targets -- -D warnings`, and `git diff --check` pass; the
  complete companion package also passes 52 tests with 231 assertions, strict
  typechecking, and a fresh bundle build.
- Account-bound ChatGPT smoke tests remain intentionally unrun: they require the
  user's authenticated companion profile and a dedicated real conversation, are
  opt-in by architecture, and never run in ordinary CI. All non-account package,
  protocol, browser-fixture, Rust integration, UI, installer, and release paths are
  covered before that live operational validation.
- The final documentation pass now distinguishes local runtime activation from the
  cached connector schema: the automation tools/marker are stable whenever agent
  chat is enabled, so toggling the runtime setting needs a service restart but not
  another schema change; upgrading from a pre-automation release still requires the
  ordinary connector Refresh and a new conversation. The focused cross-document
  contract and `git diff --check` remain green.
