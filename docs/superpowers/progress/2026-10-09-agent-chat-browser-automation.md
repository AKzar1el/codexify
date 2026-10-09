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
