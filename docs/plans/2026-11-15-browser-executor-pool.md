# Codexify browser executor pool — staged engineering plan

Status: **feature-gated two-lane scheduler and cross-process Send gate implemented in source, compiled and tested; production still uses one executor.** Do not enable the canary until both companions are independently authenticated and the patched binary/runtime passes release and health gates.
Date: 2026-11-15. Existing production path: Rust `AgentAutomationSupervisor` global `VecDeque<AutomationExecution>` and `run_lock`; one private-profile Chrome/Electron companion.

## User objective

Allow up to five independently managed browser-navigation/Send lanes for twenty active goal conversations, while preserving accepted-send deduplication, paired account identity, the ten hourly schedules, privacy, and server/host safety. A goal can continue reasoning and use Codexify tools after its browser Send has been accepted; five browser lanes are *not* twenty model compute lanes and do not guarantee provider concurrency rights.

## Precondition: prove single lane healthy

- Verify browser renderer liveness **and** ChatGPT account session separately for sustained checkpoints. Treat responsive/unverified as *degraded*, not ready.
- Address observed Windows automation state publish failures without altering ACLs or compromising atomic writes. Verify save/load and message receipts under real Windows file sharing.
- Recover/verify all previously unsent failed pairing handshakes only when session authenticated and idle; never replay ambiguous or accepted sends.
- Observe two consecutive hourly cycles with all ten original Revenue Shot schedules still enabled and no new pairing/authentication/storage failures. Record exact wall time, queue time and coding/test outcome evidence.

## Architecture (behind a default-off feature flag)

```text
Goal events / hourly wake-ups
           |
    Global fair admission control
      |        |       |
  Rate budget / session identity / immutable receipts
      |
  Dispatcher: project-aware priority + round robin + bounded queue
     |       |       |       |       |
   lane 1  lane 2  lane 3  lane 4  lane 5
   one serial browser operation *per* lane
```

- Start with **pool size 1** and reproduce current behavior. Each lane needs its *own* verified companion process, dedicated descriptor, browser home/profile, lifecycle lock, action lock and browser health stream. Never point two live Chrome processes at one profile or silently duplicate a browser identity.
- A conversation is sticky to a known lane and verified account. Reassignment requires an explicit owner-controlled, idle, no-pending-Send handoff and fresh exact-URL pairing; do not migrate ambiguous/accepted action receipts.
- One **global** rate/concurrency controller still spans all lanes, because separate profiles/queues do not create extra ChatGPT allowance. Respect Retry-After and conversation-loading cooldown; never rotate profiles/accounts to evade provider limits.
- Track `queued`, `navigating`, `sent_accepted`, `assistant_reasoning`, `tool_work`, `waiting`, `completed`, and `ambiguous` separately. Holding a browser lane while Codexify tools run is unnecessary unless the browser action or a required preference restoration is still in progress.
- Preserve the unread-chat-first policy, fair per-project round robin for goal-only turns, and a capped number of pending actions. Reject duplicate action IDs across every lane and preserve persisted server ownership across crashes.
- Never run multiple browser operations on a single Chrome tab concurrently. Keep per-lane navigation and account-maintenance locks separate from the shared **admission** lock. Active provider responses and accepted Send windows remain protected.

## Safe rollout and acceptance

1. **Single-lane baseline:** instrument queue latency (p50/p95), browser auth verification, number of accepted vs ambiguous sends, work done after Send, restart count, Windows publication errors and confirmed HTTP 429s. Freeze exact canonical conversation/account mappings.
2. **Two-lane canary:** with independent signed-in private profiles and exact account verification, admit just two noncritical, already-paired test goals. Keep aggregate Send concurrency initially **one**, increase only after the provider tolerates observed behavior. No new hourly tasks.
3. **Three-to-five lanes:** raise pool size only if the 2-lane canary improves verified completed work per hour without increasing 429s, auth failures, interference, ambiguous sends, missing receipts or CPU/memory exhaustion. Stage 3, then 5; do not jump from 1 to 5.
4. **Stop/rollback:** any new confirmed account/provider limit, repeated auth failures, Send ambiguity, host resource pressure or unbounded backlog freezes new admissions and returns to pool size 1 *after in-flight actions settle*. Never kill unknown/peer work or resend accepted actions. Restore the last verified configuration and records.

## Required tests before deployment

- Race tests: concurrent action arrivals, fairness, duplicate action ID and accepted-send replay refusal across lanes.
- Failure injection: one lane's Chrome crash, lost acknowledgement, login redirect, missing account catalog, 429+Retry-After, account switch, and browser health timeout.
- Security: profile/descriptor isolation, no token exposure, private file ACLs, no cross-account pairing or untrusted ChatGPT instructions.
- Windows: atomic state publication under simulated short sharing lock; permanent AccessDenied remains an explicit error.
- E2E: real two-lane canary with owner-visible evidence, unchanged ten hourly task schedules, and quantified throughput gains; no claims from synthetic tests alone.

## Verified offline two-browser canary (2026-11-15)

- Command: `node --test tests/two-lane-browser-canary.node.cjs` from `browser-companion/`.
- Result: **1/1 PASS**. Two separate headless Chromium processes used independent disposable profiles, navigated concurrently to a loopback-only fixture (barrier requires both browsers), and proved isolated cookies/local storage. A simulated global Send budget never exceeded one concurrent slot.
- The test made **zero ChatGPT requests** and did not open or modify the production browser home, descriptor, cookies, or session. The test closed its owned browser contexts and removed only its own temporary profile directories.
- This **does not** validate two authenticated Codexify companions, accepted-send replay fencing across executors, or a two-lane throughput gain. The currently **installed** Rust service still has only one lane; the newer source has a feature-gated second worker. Do not misreport a browser-isolation smoke as a live two-agent rollout.
- Resource preflight on this 16 GB Windows host found about 20 Chrome processes consuming roughly 3.4 GB. Measure free RAM and p95 queue/Send time before adding another persistent companion; five separate Chrome profiles may not fit comfortably.

## New source implementation and rollout requirements

- `AgentAutomationSupervisor` now maintains independent primary/canary action locks and a secondary scheduler worker; `lane_affinity.rs` deterministically partitions only the exact task key selected by the owner. All other goals stay in lane 1. Existing state-store idempotency and accepted-send fencing remain in the shared supervisor.
- `BrowserAutomationExecutor::with_canary` routes that key to a separate companion descriptor. Before executing the canary it queries **both** companions' authenticated `/v1/send-gate/status` and requires matching nonempty SHA-256 fingerprints. A legacy browser or missing gate **cannot send on lane 2**.
- The companion wraps the actual Send click **and semantic acceptance check** with `provider-send-gate.ts`: an exclusive cross-process file lock. After admission it rechecks the account, exact conversation, and draft. On a crash a stale lock is left in place, deliberately fail-closed; never automatically unlink it without reconciling accepted sends.
- Feature flags read at server startup, disabled by default: `CODEXIFY_BROWSER_CANARY_TASK_KEY` (one exact stable task key), `CODEXIFY_BROWSER_LANE2_DESCRIPTOR` (absolute descriptor of a separate signed-in browser profile) and `CODEXIFY_BROWSER_SEND_GATE_PATH` (the **same** absolute path inherited by both freshly launched companions). Missing second descriptor/shared path is a startup error. Do not set a canary key for a goal whose pairing/ownership is ambiguous.
- A deployment must bundle the **new** browser companion (the previous packaged version does not implement the provider gate), start both companion processes with independent homes/profiles, manually sign in the second profile through the supported account flow, verify identical account fingerprints, then enable exactly one noncritical canary. Never clone browser cookies or copy profiles to bootstrap authentication.
- **Tests passed:** 4 standalone Rust lane-affinity tests, `cargo check --offline --bin codexify`, TypeScript `tsc --noEmit`, 2 cross-process lock tests, 1 two-Chromium-profile isolation test, packaged Electron smoke marker. These do not replace native fleet-idle deployment tests or real two-lane provider telemetry.
- **Release gate remains closed:** production Rust 2.3.29 executable is old; a previous full optimized build failed to complete within the host's resource budget. Installing source changes requires a verified candidate binary, owned backup/rollback and quiet service lifecycle; do not hot-swap a running executable. As of the latest host check only ~1-2 GB of RAM was free after enabling WSL2, making another heavy build unsafe during active jobs.
- **Linux test environment:** Ubuntu 24.04 under WSL2 was installed and `uname -s` returned Linux without reboot. The previously blocked GodPrompt goal was resumed after a verified Linux preflight, but its later action encountered a closed/replaced browser tab; check that goal's latest state rather than claiming the benchmark has passed Linux.

## Follow-up validation and lane isolation repairs

- **Control server disconnect:** The original disconnect regression timed out on Bun 1.3.2 under Windows. It passes under Bun 1.4.3 (12/12 tests in `tests/control-server.test.ts`); an independent native Node TCP disconnect test passes in `tests/native-node-disconnect.node.cjs`. The control server listens for socket close after a completed request body and correctly uses the *response* close event for NDJSON subscribers. Never treat `IncomingMessage.close` as proof that an active response subscriber disconnected.
- **Lane ownership:** Creation, pairing, and turn-renewal remain on primary; only already-paired ordinary offline messages/goals from the one exact canary task are eligible for secondary. After pairing, the original browser releases its reservation before the secondary worker takes over. Routing is deterministic and never shifts revenue tasks by hashing or round-robin.
- **Lifecycle:** The second companion must be independently pre-launched with its own private browser home, descriptor and signed-in profile. The canary executor never invokes the primary lifecycle manager to restart the second process. Startup canonicalizes and rejects overlapping physical profile roots and duplicate descriptors. A stopped/unavailable second browser fails the canary before Send rather than touching the production Chrome profile.
- **Fencing:** The primary companion must also advertise the shared Send gate when a second lane is configured. Lane 2 additionally checks independent process IDs, matching paired account fingerprints, and identical gate fingerprints. Timeout/retained-action reconciliation and approval checks use the owning lane descriptor; never recover a canary action from the primary companion's action ledger.
- **Follow-up tests:** Five pure Rust lane-affinity checks, four native Node tests (including real two-Chromium isolation), all 12 Bun 1.4.3 control-server tests, and Rust `cargo check --offline --bin codexify --jobs 1` pass. These are **source-level gates**, not permission to claim two live production workers are running.

**Not authorized here:** purchasing credits, creating multiple ChatGPT accounts, credential/session extraction, circumventing rate limits, changing recurring schedules, replaying ambiguous messages, or restarting productive agents merely to increase the queue count.
