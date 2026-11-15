# Codexify browser executor pool — staged engineering plan

Status: **design only — do not enable additional browser executors until the single-companion health gate is proven**.
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

**Not authorized here:** purchasing credits, creating multiple ChatGPT accounts, credential/session extraction, circumventing rate limits, changing recurring schedules, replaying ambiguous messages, or restarting productive agents merely to increase the queue count.
