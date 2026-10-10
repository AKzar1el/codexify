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
- Committed the complete Task 12 documentation/security/redaction slice as
  `7483fda` (`docs: document agent chat browser automation`). Task 13 is now active:
  run the full fresh verification matrix, review every architecture invariant
  against the aggregate branch diff, resolve all findings, and complete the branch.
- Resumed Task 13 after exhaustively rereading the complete 1,336-line revised
  architecture and this complete progress journal. The branch is clean apart from
  this journal entry at `7483fda`; the active work is fresh aggregate verification,
  architecture-invariant review, corrective fixes, and branch completion.
- Task 13 fresh verification is underway:
  - the setup-widget suite passes all 30 tests;
  - the complete browser-companion suite passes 52 tests with 231 assertions;
  - strict companion TypeScript typechecking, fixture regeneration, bundle build,
    all four source-boundary tests, and the exact upstream `f9ad4ae` extraction
    check pass;
  - the release/notarization orchestration suite passes all 30 tests;
  - a fresh native darwin-arm64 companion package builds and its packaged readiness
    smoke returns `PACKAGED_BROWSER_COMPANION_SMOKE_OK darwin/arm64`;
  - fresh `cargo clippy --all-targets -- -D warnings` passes from an empty target.
- The first combined Chromium/WebKit owner/widget run reported three individual
  eight-second locator timeouts while the machine was simultaneously compiling the
  complete Rust graph and packaging Electron. The other 143 tests passed. These
  timeouts are being rerun in isolation before classifying them as product defects;
  no code change has been made from this symptom alone.
- Aggregate invariant review found a real one-window ownership bug independent of
  those timeouts: `SingleWindowCoordinator.login()` did not reject an active browser
  action, so an authenticated owner login request could navigate the shared window
  away from a generating response. A focused test failed first because login
  resolved and reached the driver; the coordinator now rejects while an action is
  active. The targeted browser-window suite passes 5 tests after the fix.
- The same one-window review found that login and capability refresh could mutate a
  manually busy shared window, while Reveal could navigate it. Focused tests failed
  first; login/capability refresh now reject busy state and Reveal exposes the
  current window without navigation. Driver-emitted events are now schema-validated
  before entering the retained stream, and one action is capped at the protocol's
  16 MiB event budget with terminal capacity reserved. The focused coordinator
  suite passes 11 tests.
- Protocol review found that a valid final answer may be up to 1 MiB while one NDJSON
  event line is limited to 128 KiB. Previously the companion emitted the complete
  final body in `generation_complete`, making long answers impossible to transport.
  A failing TypeScript test reproduced the oversized terminal line and a failing
  Rust supervisor test reproduced loss of a terminal body omitted by the helper.
  The companion now nulls only an oversized terminal copy after delivering bounded
  append-only answer deltas, and Rust reconstructs the stable final from those
  deltas. Both focused regressions pass.
- Pairing review found that the production executor expected the initial asynchronous
  execute receipt to contain a canonical URL even though the companion necessarily
  returns a queued snapshot with `canonicalUrl=null`. That made real pair verification
  fail before the browser prompt. The executor now records the already-normalized
  explicit candidate after account/catalog preflight and before the send request;
  the browser still proves the exact URL before Send and the MCP tool remains the
  authority that verifies task ownership. A real loopback-companion regression passes.
- A second pairing race existed after that fix: when `automation_verify_pairing`
  consumed the reference during generation, the supervisor tried to write the
  canonical URL again after completion and failed with `No agent-chat pairing request
  is pending`. A red executor test reproduced the tool-before-response ordering; the
  completion path now updates the canonical URL only while the pending handshake still
  exists. The exact race test passes.
- Fresh verification also exposed a stale production-executor fixture build ID left
  behind by the protocol hash change. Its focused test failed before reaching the
  intended account-mismatch assertion; the fixture now carries the current schema-bound
  build and the original behavioral test passes again.
- URL/canonicalization review found that Rust persisted owner-supplied query data even
  though the companion strips it when identifying the stable conversation. A store
  regression failed with the raw query still present; candidate and canonical pairing
  URLs now discard query data before persistence, matching the approved architecture
  and the browser protocol.
- Terminal snapshot validation also exempted pair-verification prompts from the exact
  conversation check. A production-executor test now runs both ordinary-chat and pair
  prompts against a mismatched canonical URL; the pair case failed first, and accepted
  snapshots now require the exact expected conversation for every prompt kind.
- Accepted-action stream recovery was incomplete. On a dropped NDJSON connection the
  executor reconciled terminal status but did not replay retained events, losing the
  stable browser answer; an idempotent execute receipt that was already terminal had
  the same omission. Two real loopback-companion tests failed with no recovered
  `generation_complete` event. The executor now tracks the last delivered sequence,
  resumes retained events after terminal reconciliation, and replays the ledger from
  zero for an already-terminal idempotent receipt. Both recovery paths pass without
  replaying the physical Send.
- The Rust client previously accepted monotonically increasing event sequences with
  gaps. A focused fixture proved that sequence 3 followed by terminal sequence 5 was
  treated as complete, which can silently lose an answer delta during reconciliation.
  Event delivery now requires the exact next sequence after the requested cursor; the
  existing ordered stream and new gapped-stream regression both pass.
- Resumed Task 13 again after exhaustively rereading all 1,336 lines of the revised
  architecture and this complete journal. The branch remains at `7483fda`; the
  working tree contains only the recorded Task 13 fail-closed fixes and their tests
  across the single-window coordinator, pairing/canonicalization store, companion
  stream validation, production executor recovery, and this journal. The next step
  is fresh aggregate verification before reviewing the full branch against every
  architecture invariant.
- The fresh Task 13 formatting gate initially failed on rustfmt-only layout changes
  in `src/agent_automation/supervisor.rs` and
  `tests/agent_automation_supervisor.rs`; no semantic defect was reported. The
  formatter will be applied before the remaining matrix is run.
- Fresh aggregate verification after applying rustfmt is green for the non-UI
  matrix completed so far:
  - `cargo fmt --all --check`, the explicit standalone rustfmt check, and
    `git diff --check` pass;
  - a fresh-target `cargo clippy --all-targets -- -D warnings` passes;
  - a fresh-target `cargo test --all` passes, including 594 library tests and every
    ordinary integration/doc-test target (only explicitly environment-gated tests
    remain ignored);
  - the browser companion passes 59 tests with 247 assertions, strict TypeScript
    typechecking, bundle build, fixture regeneration, all four source-boundary
    checks, and the exact upstream `f9ad4ae` extraction check;
  - setup-widget and release/notarization suites each pass 30 tests;
  - POSIX installer syntax and the full installer fixture pass;
  - a fresh native darwin-arm64 package builds and returns
    `PACKAGED_BROWSER_COMPANION_SMOKE_OK darwin/arm64`.
- The combined 148-test Chromium/WebKit owner/widget run completed with 141 passes
  and seven eight-second locator timeouts while sharing the host with two clean Rust
  builds and native Electron packaging. The reported failures are confined to four
  test bodies (setup-picker activation, two download-feedback cases, and local
  midnight refresh); they will be rerun in isolation now that the heavy jobs have
  ended before any product defect is inferred.
- The three opt-in Rust↔real-Bun protocol process tests pass on the fresh Task 13
  target: round-trip/event replay, accepted-action cancellation without replay, and
  companion restart descriptor reconciliation.
- An isolated rerun of the full Markdown-chat widget file cleared the setup-picker,
  rendered-file, midnight, and all WebKit failures. It still exposed one intermittent
  Chromium timeout in the unsupported-download feedback test; the same test passed
  under WebKit and had passed in the earlier combined run on Chromium, so it remains
  under targeted race analysis rather than being waived.
- PowerShell is not installed on this macOS host, so the Windows installer fixture
  remains covered by its workflow contract and CI rather than a local `pwsh` run.
- Architecture review found that task-state URL normalization accepted the bare
  `https://chatgpt.com/` homepage even though both protocol implementations require
  a conversation path. A focused store test failed by successfully issuing a
  pairing for the homepage; `normalize_chatgpt_url` now rejects the root path and
  the regression passes.
- Pairing review found a tool/terminal race: the model could consume the one-time
  pairing reference before terminal browser reconciliation, after which an accepted
  pair turn could fail (for example on a canonical-URL mismatch) while leaving the
  task verified. A focused supervisor test reproduced that state. Pair-action
  execution errors now invalidate the pairing, and invalidation also removes the
  pending digest index immediately; both regressions pass.
- Live-stream review found that cumulative, individually valid status/commentary
  deltas could exceed the owner-page buffer and make `run_next` return early without
  settling the persisted action. A focused executor reproduced the orphaning error.
  Transient fields are now UTF-8-safely bounded in place instead of aborting browser
  observation; answer truncation is tracked separately so a bounded prefix can never
  be mistaken for an authoritative final answer. The action now reaches its terminal
  state and persists the real final output in the regression.
- The remaining Chromium unsupported-download timeout passed in a focused 25-test
  rerun of its complete parent suite (all 25 passed). No source change or relaxed
  assertion was needed; the diagnostic-only test instrumentation was removed. The
  original aggregate timeouts are therefore recorded as host-contention flakes, not
  product failures.
- Single-window review found a real asynchronous preflight race: two concurrent
  `execute` calls could both observe no active action, await browser health in
  parallel, and each acquire the same physical window. The new red test accepted
  both actions. All browser-mutating maintenance and execute preflights now share a
  promise-serialized window operation gate, while idempotent replays are rechecked
  after acquiring it. The focused companion suite now admits exactly one concurrent
  action (12 tests passing).
- Resumed from the Task 13 review handoff after exhaustively rereading all 1,336
  architecture lines and this complete progress journal. The branch remains at
  `7483fda`; the working tree contains the accumulated fail-closed review fixes and
  tests across the one-window coordinator, protocol validation, task-state URL
  normalization, pairing invalidation, event recovery, bounded live output, and
  this journal. The next step is to review the aggregate diff against every
  remaining architecture invariant, add red tests for any uncovered defect, then
  rerun the complete verification matrix before committing.
- Owner-generation review found that accepted unread-message IDs were persisted as
  one task-global set even though the architecture scopes automatic mirror
  deduplication to the same physical-owner generation. A red supervisor test showed
  that a still-unread message accepted by owner generation 0 was never offered to a
  newly paired owner generation 1. Chat-mirror receipts now record their owner
  generation, scans ignore receipts from another generation, and the merge path
  resets the accepted-ID set when ownership changes. The focused regression passes.
- Prompt-boundary review found that queue batching counted raw Markdown bytes but
  ignored XML escaping and the fixed wake-up clauses. Two individually valid
  `<`-heavy messages were therefore combined into a browser prompt above the
  256 KiB protocol ceiling instead of being split. A red supervisor test reproduced
  the two-message batch. The queue now measures each candidate prefix with the same
  Rust prompt renderer used by protocol validation, includes the active-goal clause
  when applicable, preserves message boundaries, and queues only the largest exact
  prefix that fits. The focused regression passes.
- Send-ambiguity review found that the executor error flag could remain `false`
  after the supervisor had already consumed a `send_accepted` event. A later status
  or transport failure would then be persisted as safely retryable `failed`, despite
  direct evidence that ChatGPT accepted the message. A red regression reproduced
  that state. Supervisor settlement now treats either the terminal error flag or the
  retained event ledger as acceptance evidence, records the mirrored batch, and
  persists `ambiguous`; the focused test passes.
- Long-lived companion review found that every completed request, full prompt, and
  up-to-16-MiB event ledger remained resident for the lifetime of the GUI process.
  A red companion test showed the oldest completed action still retained its full
  stream after more than the intended history window. The coordinator now keeps at
  most eight full action ledgers, compacts older terminal actions to bounded
  idempotency tombstones with no event payload, retains safe execute/status replay
  without rerunning the browser, and bounds retired-action and cancel-key caches.
  The focused 13-test companion suite and strict TypeScript check pass.
- Persistent chat-mirror review found that accepted message IDs were never removed
  after `chat_read` consumed those messages. The bounded 1,024-ID history could
  therefore fill permanently and make a later accepted browser Send fail during
  settlement. A red test prefilled consumed IDs and reproduced the failure on the
  next unread message. Each scan now intersects accepted receipts with the current
  unread snapshot, clears stale metadata, and persists only still-relevant IDs; the
  focused regression passes.
- Execute-receipt review found another acceptance ambiguity before event streaming:
  a 2xx execute response with a lost or malformed body, followed by an unavailable
  action-status probe, was surfaced as a pre-Send failure. The owner could then
  explicitly retry with a fresh action even though the companion may already have
  started the original one. A red production-executor fixture reproduced the false
  `send_accepted=false` result. The companion client now carries typed uncertainty
  through execute/reconciliation attempts, distinguishes connection failures from
  requests that may have reached the companion, and the production executor maps an
  unreconciled accepted receipt to `ambiguous`. The focused regression passes.
- Companion event-order review found that a buggy driver could emit answer deltas or
  `generation_complete` without ever proving semantic Send acceptance. The
  coordinator would retain and expose that output as a successful idle action. A
  red driver fixture reproduced the premature final answer. Driver events now must
  prove the exact requested model/effort, then connector selection, then Send
  acceptance before response output; completion must also report the exact expected
  conversation. Invalid order fails before entering the stream, or becomes
  `ambiguous` after acceptance. The focused 14-test coordinator suite and strict
  TypeScript check pass.
- Stable-answer persistence review found a protocol/store size mismatch: the
  browser stream may reconstruct up to 1 MiB of final Markdown, while private action
  diagnostics intentionally retain at most 64 KiB. The supervisor appended the full
  valid answer to `CHAT.md` and then failed its final state write, leaving the action
  orphaned. A red 80 KiB final-answer regression reproduced the failure. Full stable
  output remains authoritative in the transcript and live state; oversized answers
  are now omitted only from the bounded persisted diagnostic field, allowing the
  action to settle `idle`. The focused regression passes.
- Single-window teardown review found a narrow terminal race: the coordinator
  released `activeActionId` as soon as the driver emitted its terminal event, before
  the driver's async cleanup and Electron `endAction()` had returned. A concurrent
  execute could therefore acquire the same physical window during that gap. A red
  lingering-driver test accepted the second action. Window ownership now remains
  active until the entire driver promise unwinds; terminal events still unblock
  neither stream readers nor maintenance prematurely: retained terminal events are
  delivered only after the driver promise settles, cancellation and shutdown wait
  for the same boundary, and the next action stays excluded throughout cleanup. The
  strengthened focused race regression and strict TypeScript check pass.
- Error-terminal review found that an upstream selector or browser failure message
  above the protocol's 64 KiB delta limit made the coordinator's own terminal-event
  validation throw. The action then lost window ownership without ever becoming
  terminal, leaving status/event clients orphaned. A red oversized-error driver
  reproduced the invalid Zod event; a second red fixture proved an embedded NUL had
  the same effect. Browser-originated terminal messages now replace NUL and truncate
  on a UTF-8 boundary before event construction; the action reaches a bounded
  `failed` or `ambiguous_send` terminal state. Both focused regressions and strict
  TypeScript checking pass.
- Resumed the Task 13 aggregate review after exhaustively rereading all 1,336 lines
  of the revised architecture and all 1,048 existing progress-journal lines. The
  checkout still matches the saved handoff: `HEAD` is `7483fda`, and the only
  working-tree changes are the accumulated fail-closed review fixes plus their
  focused tests and this journal. The active step remains invariant-by-invariant
  review before the final clean verification and commit.
- The resumed companion review immediately exercised the pending post-Send attention
  regression. The focused browser-window suite failed as intended: an
  `approval_required` terminal action had proven semantic Send acceptance but its
  snapshot still exposed `canonicalUrl=null`, so Rust would downgrade the exact
  approval state into a conversation-proof failure. The next fix binds the already
  verified expected conversation to the snapshot at `send_accepted`, before any
  post-Send terminal state can settle.
- The post-Send canonical-URL regression is green: the focused browser-window suite
  passes 18 tests, and approval/attention snapshots now retain the exact verified
  conversation as soon as semantic Send acceptance is recorded.
- Event-resume review found a cleanup-boundary race not covered by the existing
  terminal-stream test. A client reconnecting with `after` already equal to the
  terminal sequence returned immediately while the driver still owned the Electron
  window, allowing Rust to schedule the next action into a cleanup gap. The new
  focused test fails with `settled` instead of waiting for driver teardown.
- The terminal-cursor cleanup regression is green: event resumption now waits for
  the driver promise to unwind even when the caller's cursor is already at the
  terminal event, preserving exclusive window ownership through teardown.
- Error-line review found that the existing 64 KiB terminal-message clamp bounded
  UTF-8 input but not JSON expansion. A failure made of backslashes and control
  characters passed the text schema, expanded beyond the 128 KiB NDJSON line limit,
  and caused the coordinator's own fallback event to throw, orphaning the action.
  The focused regression fails at the protocol line-limit assertion before the
  sanitizing/bounding fix.
- The JSON-expanding terminal-error regression is green together with the complete
  browser-window suite (20 tests, 65 assertions). Control characters are normalized
  and the retained public message is conservatively bounded so its serialized NDJSON
  terminal event cannot exceed the line limit.
- Execute-reconciliation review found another unsafe downgrade: a malformed body on
  a successful HTTP 2xx execute response correctly carried acceptance uncertainty,
  but an immediate action-status 404 reset that evidence to `send_accepted=false`.
  The focused production-executor regression now fails on that exact false result;
  a racy or faulty status lookup must not make an already-reached execute request
  safely retryable.
- The successful-receipt/status-404 ambiguity regression is green. Execute
  reconciliation now preserves acceptance uncertainty through both the initial and
  same-idempotency retry attempts, including an absent status result, so a request
  known to have reached companion protocol handling can never be surfaced as a
  safely retryable pre-Send failure.
- Persistent mirror-capacity review found that 1,024 still-unread accepted message
  IDs filled the bounded receipt history, but the supervisor still queued a 1,025th
  message. Its physical Send would succeed before settlement failed to persist the
  deduplication receipt, creating a replay hazard. The focused regression currently
  observes one queued action instead of the required pre-Send task-local failure.
- The full accepted-history regression is green. Scan-time eligibility now refuses
  new unread browser work before queueing when every bounded mirror-receipt slot is
  still needed by unread accepted messages, records a task-local failed state, and
  leaves the new message unread with zero companion executions. Consumed receipts
  continue to be pruned and free capacity normally.
- Terminal-receipt review found that Rust accepted a successful `idle` action
  snapshot with `sendAccepted=false`, no selected model, and no canonical URL. That
  contradictory response could be persisted as a clean idle action and automatically
  requeued, even though the execute request had reached the companion. The focused
  real-executor regression currently returns success instead of a fail-closed
  ambiguous receipt.
- The terminal-idle receipt regression is green. Rust now treats post-Send terminal
  states (`idle`, approval, ambiguous, and stalled) without semantic acceptance proof
  as protocol uncertainty, and terminal snapshot validation preserves ambiguity for
  wrong-action, model/effort, and conversation mismatches rather than exposing an
  explicit retry path.
- Delta-line review found the same JSON-expansion problem on valid response content:
  a 64 KiB answer made entirely of backslashes satisfies the Markdown delta bound but
  serializes above the 128 KiB NDJSON line ceiling. The coordinator converted the
  otherwise valid response into `ambiguous_send`, and the focused regression sees
  zero answer deltas instead of a lossless bounded split.
- The JSON-expanding answer regression is green. Valid status/commentary/answer
  deltas whose serialized form exceeds one NDJSON line are now split losslessly on
  UTF-8 boundaries with exact continuation semantics; the complete Markdown and
  terminal completion survive and every emitted line remains protocol-bounded.
- Stream-reconciliation review found that a well-formed queued execute receipt,
  followed by an unavailable event stream and action-status endpoint, was classified
  as `send_accepted=false`. The companion had already accepted ownership of the
  action and could continue toward Send asynchronously, so the focused regression
  fails on the unsafe retryable classification.
- The unreconciled-stream regression is green. Once the companion has returned a
  valid nonterminal execute receipt, loss of both event observation and terminal
  status is always treated as acceptance uncertainty unless a reconciled terminal
  pre-Send state proves otherwise; the owner cannot explicitly replay that action.
- The complete companion suite is green after the review fixes: 69 tests and 283
  assertions pass, including control-server shutdown, one-window ownership,
  JSON-expanding deltas, terminal cleanup, protocol fixtures, and packaging
  contracts; strict TypeScript checking also passes. The shutdown fixture was
  corrected to perform the same model/connector verification sequence required of a
  real accepted Send before testing ambiguous cancellation.
- The directly affected Rust suites are green after the new uncertainty and receipt
  bounds: 17 companion tests, 12 store tests, and 47 supervisor tests pass. This
  includes the real HTTP executor, full unread-receipt capacity, stream recovery,
  owner-generation invalidation, pairing races, and transcript fallback behavior.
- Terminal-receipt replay review found an asymmetry in recovery: a dropped retained
  event stream was resumed for a newly queued action after status reconciliation,
  but not when the idempotent execute call immediately returned an already-terminal
  action. The strengthened existing test now drops after sequences 1–2 and fails
  with an incomplete-event error instead of reconnecting from sequence 2.
- The already-terminal replay regression is green. The executor tracks only events
  actually delivered to the supervisor and retries the retained ledger once from the
  last contiguous sequence, so a response-loss retry still recovers status,
  commentary, answer, and completion without replaying the browser action.
- Account-binding review found that changing the live ChatGPT account invalidated a
  verified pairing but left an in-progress pairing reference and its private digest
  index usable. The focused store regression changes the account after canonical URL
  capture and currently finds the old pending reference intact, contrary to the
  account-fingerprint invalidation rule.
- The account-change pairing regression is green. Updating to a different
  privacy-preserving account fingerprint now atomically revokes the pending reference,
  removes its digest index, clears verification, and leaves the task explicitly
  unverified while retaining only non-authoritative URL history for user repair.
- Window-lifecycle review found that `cancel` and `close` stopped sending the abort
  signal as soon as a terminal event existed, even though the browser driver could
  still be unwinding and retained exclusive window ownership. The focused shutdown
  regression emits completion and then waits for abort; it currently remains blocked
  until the test manually releases the driver.
- The post-terminal cleanup shutdown regression is green. Cancellation and process
  shutdown now abort every still-retained driver controller before awaiting teardown;
  aborting an already-settled controller is harmless, while a terminal-but-unwinding
  browser action can no longer deadlock companion shutdown or window reuse.
- Restart review found that a persisted queued pair-verification action cannot be
  reconstructed because the raw one-time reference is deliberately never persisted.
  A fresh supervisor nevertheless left the digest, pending state, and `queued`
  action intact with no in-memory queue entry. The focused restart regression finds
  that unrecoverable pairing transaction still pending instead of revoked.
- The queued-pair restart regression is green. On the first registration in a fresh
  supervisor, a persisted queued pair-verification action with no recoverable raw
  capability is revoked, its digest index is removed, and the task returns to an
  explicit unverified state; repeated registration in the same live supervisor does
  not disturb a real in-memory pairing action.
- Restart review then found the analogous stale-state problem for ordinary queued
  work: if its unread message was consumed before restart, the fresh supervisor had
  no queue entry and no work to reconstruct, but the persisted action remained
  `queued` indefinitely. The focused regression observes that stale queued state
  instead of a clean idle action.
- The stale ordinary-queue restart regression is green. A fresh supervisor now
  clears only reconstructable non-pair queued envelopes before rescanning
  authoritative chat/goal state; pending work is rebuilt with a fresh action identity,
  while already-consumed work leaves a clean idle record and no phantom queue row.
- Persistent-state review found that syntactically valid but logically impossible
  records did not fail closed. A selection could retain model/catalog/account while
  losing only its effort, accepted-message history could contain duplicate IDs, and
  one pairing could be both pending and verified. The focused corruption regression
  currently loads the partial selection successfully instead of rejecting the state.
- The logical-state corruption regression is green. Persisted selections are now
  either wholly absent or contain model, effort, catalog revision, and account
  fingerprint together; accepted-message IDs are unique and carry complete receipt
  metadata; and a pairing cannot be both pending/candidate and verified. Corrupt
  records are preserved and rejected rather than normalized silently.
- Extending the same corruption test found two remaining incomplete-state shapes:
  a `queued` action can omit its action ID, and a goal wake can record a nudge epoch
  without its sequence/timestamp. The focused test currently loads the ID-less
  queued action successfully instead of rejecting the record.
- Resumed from that exact Task 13 handoff after exhaustively rereading all 1,336
  architecture lines and the complete 1,202-line progress journal. The checkout is
  still on `feat/agent-chat-browser-automation` at `7483fda`, with only the recorded
  aggregate-review fixes and tests in the working tree.
- The persisted-state incomplete-shape regression is now green. `validate_action`
  rejects every in-flight/attention/stalled state without an action identity, and
  `validate_goal_wake` requires each epoch to carry its sequence plus every recorded
  nudge to carry a timestamp and match the current activity epoch. The exact
  `logically_inconsistent_persisted_state_fails_closed` test passes.
- Event-stream liveness review found that the real companion emits blank NDJSON
  heartbeats every 30 seconds, while the Rust idle timeout was applied independently
  to each raw HTTP chunk. Heartbeats therefore reset the deadline forever even when
  no semantic browser event arrives. A focused raw-loopback regression sends one
  nonterminal event followed only by frequent heartbeat chunks; it currently times
  out at the test harness instead of returning `Browser companion event stream
  stalled`, reproducing the unbounded stall.
- The heartbeat-masked idle regression is green. Rust now keeps one deadline for the
  next complete semantic event and advances it only after a valid nonblank event is
  parsed; transport heartbeats and partial lines no longer keep a stalled action
  alive indefinitely. All four event-stream ordering, bounds, ordinary-idle, and
  heartbeat-idle tests pass.
- Queued-message revalidation review found that execution checked only whether each
  unread message ID still existed. A user or editor could change the Markdown under
  the same explicit message ID after queueing, and the browser would send the stale
  snapshot. A focused test edits the queued message body in `CHAT.md`; it currently
  executes the old prompt instead of discarding and rebuilding the stale action.
- The stale queued-message regression is green. Immediate pre-Send validation now
  requires the queued IDs, ordering, and exact Markdown to match the current unread
  snapshot. Edited content invalidates the old action before the companion is called;
  the next scan rebuilds it with the revised text. Both coalescing and edited-message
  focused tests pass.
- Owner-generation review found a post-Send race: registering a new physical owner
  invalidated the pairing but retained the running action ID. When the old browser
  response settled, the supervisor still treated that action as current, persisted
  its final answer, and overwrote `unverified` with `idle`. A focused generation-race
  test reproduces the incorrect terminal `idle` state and old-owner output.
- The owner-generation race is green. Registration of a changed owner now atomically
  invalidates pairing and supersedes the persisted action identity while retaining
  the private URL only as unverified history. The old accepted browser turn may
  settle, but its final text and terminal receipt cannot mutate the new owner state;
  both queued and in-generation owner-change tests pass.
- Cross-language bound review found that protocol v1 permits terminal attention and
  failure messages up to 64 KiB, and the TypeScript companion emits within that
  bound, but Rust still rejected anything above 4 KiB. A focused 8 KiB terminal
  failure event is valid on the wire yet currently fails with `browser failure
  message is invalid`.
- The terminal-message bound mismatch is green. Rust event validation now uses the
  protocol's 64 KiB attention-message limit consistently with TypeScript and action
  snapshots; the 8 KiB cross-language event is accepted while the existing line and
  stream ceilings remain authoritative.
- Protocol text-bound review found that the manifest specifies UTF-8 byte limits,
  but TypeScript's visible-text helper used JavaScript string length. Forty emoji
  therefore passed the 128-byte connector-name schema at 160 UTF-8 bytes even though
  Rust rejects the same request. The focused contract test fails by accepting it.
- The visible-text byte-bound regression is green. TypeScript now enforces UTF-8
  bytes in addition to nonblank/control-free text, so connector names, labels,
  reasons, and all other manifest-bound visible strings agree with Rust. The focused
  protocol contract test and strict TypeScript check pass.
- The same visible-text review found a Unicode-category mismatch: TypeScript rejected
  only ASCII C0/DEL controls, while Rust rejects every Unicode control character.
  A connector name containing U+0085 is therefore accepted by TypeScript and rejected
  by Rust; the focused contract assertion is red.
- The Unicode-control mismatch is green. TypeScript visible-text validation now uses
  the Unicode `Cc` category, matching Rust's control-character rejection. The focused
  contract test and strict typecheck pass.
- Account-binding review found the same terminal race as physical-owner replacement:
  changing the live account invalidated pairing but retained the active action ID.
  The old account's browser response then settled as `idle` and could persist its
  final output. A focused in-generation account-change test reproduces the incorrect
  terminal state.
- The in-generation account-change race is green. Account replacement now revokes
  the pending/verified pairing and supersedes the persisted action identity in the
  same locked write, so output from the old ChatGPT account cannot settle into the
  task. The existing pending-reference revocation test and the new active-generation
  regression both pass.
- The directly affected aggregate suites remain green after the resumed review:
  19 companion-client tests, 14 persistent-store tests, and 52 supervisor tests pass.
  The complete browser companion passes 70 tests with 287 assertions plus strict
  TypeScript checking, including the new UTF-8/control contract cases.
- Pairing-reference review found one more Rust/TypeScript mismatch. TypeScript
  accepted any 43 URL-safe characters, including non-canonical trailing base64 bits,
  while Rust's decoder requires an exact canonical 32-byte base64url value. The
  focused contract test accepts `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB`
  instead of rejecting it.
- The canonical base64url regression is green. The shared token/reference schema now
  round-trips through a 32-byte decode before accepting a value, so descriptor bearer
  secrets and pairing references obey the same exact contract as Rust. The focused
  protocol test and strict TypeScript check pass.
- The resumed invariant review is complete for the current aggregate diff. Its new
  red-green fixes cover persisted-state completeness, semantic event-stream liveness,
  exact queued-message content, physical-owner and account replacement during a
  browser turn, terminal-message bounds, UTF-8/control validation, and canonical
  base64url credentials. No further high-confidence architecture violation remained
  in this pass; Task 13 has moved to fresh full-matrix verification.
- Resumed the final Task 13 verification pass after exhaustively rereading all 1,336
  lines of the revised architecture and all 1,296 existing journal lines. The
  checkout is still on `feat/agent-chat-browser-automation` at `7483fda`, with the
  accumulated fail-closed review fixes in 12 modified files. The next operation is
  the complete fresh formatting, Rust, companion, installer, packaging, workflow,
  and Chromium/WebKit verification matrix before aggregate diff review and commit.
- The final formatting gate is green: `cargo fmt --all --check`, the explicit
  standalone `rustfmt --edition 2024 --check` invocation, and `git diff --check`
  all passed. The host currently has 131 GiB free, so the remaining fresh builds can
  use isolated `/tmp` targets without repeating the earlier low-space failure.
- The first fresh-target Clippy run exposed one real static-analysis regression:
  `AgentAutomationStore::record_accepted_batch` now has eight parameters after the
  owner-generation deduplication fix, exceeding the repository's seven-argument
  limit. No warning is being waived; the call surface will be reduced under focused
  tests before restarting the full matrix.
- The Clippy regression is fixed without an allow attribute. Accepted mirror data is
  now carried by one typed `AcceptedChatBatch` value shared by current and superseded
  settlement paths, reducing the store method surface while preserving all receipt
  invariants. The complete 52-test supervisor suite passes, and the resumed
  fresh-target `cargo clippy --all-targets -- -D warnings` run is green.
- The full fresh Rust matrix is green on the same isolated target:
  `cargo test --all` passed all 594 library tests and every ordinary integration and
  doc-test target. Only the explicitly environment-gated real-Bun, Apprise, and
  subprocess fixtures remain ignored by the ordinary aggregate command; their
  browser-companion process cases are run separately below.
- Fresh companion verification is green: strict TypeScript checking passed; all 70
  Bun tests passed with 288 assertions; the bundle built at 155.50 KiB; regenerating
  protocol fixtures produced the checked-in hash
  `edc90b30a9de09b1e992d4384ac1df24b08e4a98d8e52687a2542dee561877b2`
  with no diff; all four source-boundary tests passed; and the exact upstream
  extraction check still matches `miuuyy/codex-chatgpt-web` commit `f9ad4ae`.
- Fresh native packaging produced the expected darwin-arm64 archive, but the packaged
  smoke failed before launching Electron because its helper imposed the same 60-second
  timeout on `tar -xzf`; extraction hit `ETIMEDOUT`. This is being treated as a
  reproducible smoke-harness defect, not waived as host load: archive size and actual
  extraction time are being measured before changing the timeout contract.
- The package-smoke timeout defect is green under TDD. The 109 MiB archive contains
  607 entries and took 184.107 seconds to extract on this host, proving the generic
  60-second command limit was inappropriate for extraction rather than for the
  packaged app launch. The smoke harness now gives only archive extraction a bounded
  ten-minute budget while retaining the one-minute runtime readiness deadline. The
  focused packaging contract passes 2 tests with 25 assertions, and the same native
  artifact now returns `PACKAGED_BROWSER_COMPANION_SMOKE_OK darwin/arm64`.
- The first explicit real Rust↔Bun contract run failed uniformly before HTTP: all
  three tests reached their 15-second descriptor-publication assertion. Because the
  fixture hides child stdout/stderr, this is being debugged at the process boundary
  by launching the exact Bun fixture directly and timing descriptor publication;
  no protocol behavior is being changed from the timeout symptom alone.
- Direct fixture evidence showed one Bun server publishes its descriptor in 11.340
  seconds, leaving too little margin when all three ignored process tests cold-start
  concurrently. The bounded test-fixture publication deadline is now 60 seconds.
  The next run then exposed a stale blocking driver that emitted `send_accepted`
  before model and connector verification, which the hardened coordinator correctly
  rejected. Updating that fixture to the real event order made all three explicit
  Rust↔Bun process contracts pass: round-trip/retained events, accepted cancellation
  without replay, and restart descriptor reconciliation.
- Installer and release orchestration are green on the available host: all 30
  release/notarization tests passed, both POSIX scripts pass syntax validation, and
  the complete POSIX installer fixture passed including the browser opt-in path.
  PowerShell remains unavailable locally and is still exercised by its dedicated
  Windows workflow and checked workflow contract.
- The unloaded Chromium/WebKit matrix is fully green: all 30 setup-widget tests and
  all 148 sequential Markdown-chat, owner-chat, workspace-switch, workspace-widget,
  and workspace-picker tests passed with zero retries, timeouts, or relaxed
  assertions. This clears the earlier host-contention failures and verifies the
  standalone-only automation UI plus embedded-widget isolation on both engines.
- Final protocol review found one remaining Rust/TypeScript bound mismatch. The
  checked-in protocol defines connector/model/effort visible-text limits in UTF-8
  bytes and TypeScript now enforces that contract, but Rust still counted UTF-16
  code units. A focused request with forty emoji reached the fake companion instead
  of being rejected locally; `invalid_action_data_is_rejected_before_network_access`
  failed with one unexpected network POST, providing the red phase for the fix.
- The UTF-8 visible-text regression is green. Rust now applies the manifest's byte
  limits directly, so the same forty-emoji connector name is rejected before any
  network access; the exact focused companion-client test passes.
- Queued-message order review found that immediate pre-Send validation compared the
  stored IDs and Markdown but searched each ID independently in the current unread
  snapshot. Reordering two still-unread message blocks under the same IDs therefore
  sent the stale queued order. A focused supervisor test rewrites the transcript as
  second-then-first and fails because `run_next` executes the old first-then-second
  prompt instead of discarding it.
- The queued-order regression is green. Pre-Send validation now derives the current
  ordered, unaccepted unread prefix for the same owner generation and compares IDs
  plus exact Markdown positionally. Reordered or inserted content invalidates the
  stale action; the next scan rebuilds the prompt in authoritative transcript order.
- Queue-local failure review found that capacity, prompt-size, and receipt-history
  failures persisted `status=failed` without an action ID. Automatic rescans then
  stayed blocked, while the standalone Retry control is intentionally disabled when
  no exact action ID exists. A strengthened capacity test fails at the missing retry
  identity before the queue can be drained and explicitly retried.
- Queue-local failures are now explicitly repairable. Each pre-Send queue failure
  receives a fresh opaque action identity, so the owner can drain or repair the
  underlying condition and invoke the existing exact-ID Retry path. The capacity
  regression now drains the earlier action, retries the failed task, obtains a new
  queued action identity, and leaves both original messages unread throughout.
- Idempotent execute-receipt review found that a recovered nonterminal companion
  snapshot started event observation after the snapshot's current sequence. If the
  first execute response was lost after answer deltas had already been retained,
  Rust skipped that prefix and could reconstruct only the later suffix when the
  terminal event intentionally omitted its large final Markdown. A real loopback
  test fails with `" and suffix"` instead of `"Retained prefix and suffix"`.
- Nonterminal idempotent recovery now replays the retained event ledger from
  sequence zero before following new events. The real loopback regression receives
  both the retained prefix and later suffix, while the companion's action identity
  and idempotency key still prevent a second physical Send.
- Stream-disconnect review found that Rust only reconnected when the first status
  reconciliation already reported a terminal action. If the companion correctly
  reported that the same accepted action was still generating, the executor stopped
  with ambiguity instead of resuming its retained event ledger. The strengthened
  loopback regression now returns `generating` on the first status check and fails
  before the second event-stream connection is attempted.
- Nonterminal stream recovery is green. After one dropped retained stream, Rust now
  reconciles the exact action, reconnects once from the last contiguous sequence
  while it is still generating, and only falls back to ambiguity if observation is
  lost again. The loopback test sees two stream connections, generating-then-idle
  status reconciliation, and the complete recovered answer without another Send.
- Companion terminal-error review found that the error sanitizer returned an empty
  string unchanged. An internal `BrowserCompanionError("")` therefore made the
  terminal `failed` event violate its own nonempty protocol schema and left the
  action without a consumable terminal event. The focused Bun regression fails with
  the expected Zod `too_small` error.
- Empty companion failures are now normalized to the same bounded generic message
  used for unknown failures, so every action receives a valid terminal event. The
  focused Bun regression passes and observes `Browser companion operation failed`.
- Browser-health review found that every outer driver failure was reported as
  `authentication_required`, including a destroyed shared Electron window. That
  misdirects the owner toward sign-in instead of repairing unavailable browser
  infrastructure. A focused surface fixture fails because the destroyed-window
  error returns `authentication_required` rather than `unavailable`.
- Browser health now distinguishes failed authentication proof from unavailable
  browser infrastructure. The driver wraps only composer authentication failure as
  `authentication_required`; a destroyed or otherwise unusable shared window remains
  `unavailable` with its bounded repair diagnostic. The focused Bun test passes.
- Persistent-state follow-up found that `failed` was the one repairable action state
  still allowed without an action ID. Although all live queue failures now receive
  one, a syntactically valid corrupt record could silently recreate the disabled
  Retry state. The strengthened logical-consistency test fails because a failed
  offline-chat action with `id=null` still loads successfully.
- Failed action persistence now requires an exact opaque identity just like every
  other repairable non-idle state. The logical-consistency regression passes, so a
  corrupt no-ID failure disables automation fail-closed instead of creating an
  unrecoverable owner UI state.
- Account-binding review found a narrow race after Rust's health/capability
  preflight: `ChatGptBrowserDriver.execute` refreshed its local capability cache when
  the page account differed, then continued toward Send. A browser account switch
  between preflight and execution could therefore bypass the persisted account
  fingerprint. The focused policy test is red because the driver has no fail-closed
  capability-account assertion yet.
- Browser execution now requires the exact account fingerprint established by the
  immediately preceding capability refresh. A missing cache asks for an explicit
  refresh; a changed account fails as external interference before composer or Send
  mutation. The focused Bun policy regression passes.
- The directly affected aggregate suites are green after the final review fixes:
  - Rust companion client — 19 passed;
  - secure automation store — 14 passed;
  - offline/global supervisor — 54 passed;
  - browser companion — 73 passed with 296 assertions across 16 files;
  - strict TypeScript typechecking passed;
  - `cargo fmt --all` and `git diff --check` passed before these suite runs.
- The fresh full-matrix Clippy run found one API-shape regression introduced by the
  explicit queue-failure identity fix: `record_queue_failure` now has eight total
  parameters. The warning remains fatal under `-D warnings`; it will be reduced with
  a typed failure envelope rather than suppressed.
- The typed queue-failure envelope removed the argument-count warning, and Clippy
  then exposed its intended crate-private boundary: the store method remained
  publicly reachable while its envelope is `pub(crate)`. Only the supervisor calls
  this mutation, so the method is being narrowed rather than widening an internal
  protocol type.
- The queue-failure API is now one crate-private typed envelope and Clippy is green
  across all targets under `-D warnings`; no lint exception was added.
- Fresh verification from the final edited tree is green so far:
  - formatting: `cargo fmt --all --check`, explicit standalone `rustfmt`, and
    `git diff --check` passed;
  - static analysis: `cargo clippy --all-targets -- -D warnings` passed;
  - Rust: `cargo test --all` passed all 594 library tests plus every ordinary
    integration and doc-test target; only explicitly environment-gated fixtures were
    skipped by that aggregate command;
  - companion: strict TypeScript checking, 73 Bun tests with 296 assertions, the
    156.0 KiB bundle, all four extraction-boundary tests, exact upstream commit
    verification, and generated protocol-fixture identity all passed;
  - release/UI: 30 release/notarization tests, 7 webhook-relay tests, 30 setup-widget
    tests, and 148 sequential Chromium/WebKit owner/chat/workspace tests passed;
  - POSIX installer syntax and the complete installer fixture passed; PowerShell is
    unavailable on this macOS host and remains covered by the Windows workflow.
- The environment-gated and packaged-runtime checks are also green:
  - all five Rust↔real-Bun protocol tests passed, including retained events,
    accepted cancellation without replay, and companion restart reconciliation;
  - the versioned darwin-arm64 Electron archive built successfully and its packaged
    readiness smoke returned `PACKAGED_BROWSER_COMPANION_SMOKE_OK darwin/arm64`;
  - the isolated Apprise dependency environment passed all eight Python adapter
    tests; the Rust notification subprocess fixtures are running separately below.
- The environment-gated notification integration is green as well: all six
  `markdown_chat_notifications` tests and all 22 `markdown_chat_tools` tests passed
  with the real Apprise runtime and local HTTP receiver enabled.
- Final Task 13 verification is complete from the post-review tree. Formatting and
  diff checks, all-target Clippy, the complete Rust suite, strict TypeScript,
  companion unit/contract/boundary/upstream checks, native packaging and packaged
  smoke, real Rust↔Bun process contracts, release/notarization and webhook tests,
  POSIX installer fixtures, real Apprise integration, and the full unloaded
  Chromium/WebKit matrix are green. The only host limitation is the absence of
  PowerShell on macOS; Windows syntax, installer behavior, and release packaging
  remain enforced by checked workflow contracts and the Windows CI job.

- Local integration was requested after Task 13. The separate anti-starvation work
  found in the source checkout was verified and preserved as commit `1650b76`
  (`feat: contain blocking work and unresponsive upstreams`) before merging.
- A clean temporary `main` worktree was created at the published `v1.7.0` baseline;
  `main` fast-forwarded to `1650b76`, then merged the browser-automation branch.
  The only source conflict was `src/server.rs`. Resolution preserves both sides:
  continuation owner generations and task-rooted automation context, plus audited
  cancellable checkpoint waits, self-managed checkpoint tools, and nonblocking
  read-side checkpoint initialization. Two anti-starvation test fixtures were
  updated for the new `ToolRequestContext` owner-generation/automation fields.
- Merged-tree verification is green so far:
  - formatting, `git diff --check`, and all-target Clippy passed;
  - `cargo test --all` passed 604 library tests and every ordinary integration and
    doc-test target;
  - all five real Rust-to-Bun contract tests passed;
  - strict companion typechecking, 73 Bun tests with 296 assertions, the 156.0 KiB
    bundle, and all four extraction-boundary tests passed;
  - the darwin-arm64 package and packaged readiness smoke passed;
  - the POSIX installer fixture passed.
- The first merged Chromium/WebKit matrix was intentionally run concurrently with
  Cargo and Electron packaging and produced two Chromium-only eight-second download
  callback timeouts; the identical WebKit cases passed. The complete matrix is being
  rerun unloaded before the merge is committed.
- The unloaded merged browser matrix is fully green: all 148 sequential
  Chromium/WebKit owner/chat/workspace tests passed. This confirms the earlier two
  Chromium download timeouts were host-contention artifacts rather than a merged
  behavioral regression.
- Final merged operational verification is green: 30 release/notarization tests,
  seven webhook-relay tests, exact generated protocol-fixture identity, exact
  upstream-boundary verification, eight Python Apprise adapter tests, all six real
  notification subprocess tests, and all 22 chat-tool tests passed.
- The local merge is therefore verified across both feature surfaces: bounded
  filesystem/upstream/checkpoint execution and optional single-window agent-chat
  browser automation. Existing source and Codexify-managed worktrees remain
  preserved; only the clean temporary `main` worktree was used for integration.
