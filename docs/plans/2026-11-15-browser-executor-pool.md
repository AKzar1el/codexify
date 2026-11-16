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
- Feature flags read at server startup, disabled by default: `CODEXIFY_BROWSER_CANARY_TASK_KEY` (one exact stable task key), `CODEXIFY_BROWSER_LANE2_DESCRIPTOR` (absolute descriptor of a separate signed-in browser profile) and `CODEXIFY_BROWSER_SEND_GATE_PATH` (the **same** absolute path inherited by both freshly launched companions). The same three values can now be persisted as `agentChat.automation.canaryTaskKey`, `lane2DescriptorPath`, and `providerSendGatePath` in the regular Codexify configuration. Configuration validation refuses incomplete settings; the primary companion launcher passes the configured Send gate to its child process. Missing second descriptor/shared path is a startup error. Do not set a canary key for a goal whose pairing/ownership is ambiguous.
- A deployment must bundle the **new** browser companion (the previous packaged version does not implement the provider gate), start both companion processes with independent homes/profiles, manually sign in the second profile through the supported account flow, verify identical account fingerprints, then enable exactly one noncritical canary. Never clone browser cookies or copy profiles to bootstrap authentication.
- **Tests passed:** 4 standalone Rust lane-affinity tests, `cargo check --offline --bin codexify`, TypeScript `tsc --noEmit`, 2 cross-process lock tests, 1 two-Chromium-profile isolation test, packaged Electron smoke marker. These do not replace native fleet-idle deployment tests or real two-lane provider telemetry.
- **Release gate remains closed:** production Rust 2.3.29 executable is old; a previous full optimized build failed to complete within the host's resource budget. Installing source changes requires a verified candidate binary, owned backup/rollback and quiet service lifecycle; do not hot-swap a running executable. As of the latest host check only ~1-2 GB of RAM was free after enabling WSL2, making another heavy build unsafe during active jobs.
- **Updated maintenance state:** A later unoptimized Windows native candidate built successfully and its source-level tests passed. An independently signed-in second browser is still required; the first canary launched successfully but was not authenticated at the last check. The Windows service task requires an elevated maintenance runner and the original 10 hourly schedules must be quiet. Run `scripts/preflight-two-browser-rollout.ps1` read-only to distinguish install readiness from canary activation readiness. Never interpret a source build or package smoke test as permission to restart a busy production service.
- **Linux test environment:** Ubuntu 24.04 under WSL2 was installed and `uname -s` returned Linux without reboot. The previously blocked GodPrompt goal was resumed after a verified Linux preflight, but its later action encountered a closed/replaced browser tab; check that goal's latest state rather than claiming the benchmark has passed Linux.

## Follow-up validation and lane isolation repairs

- **Control server disconnect:** The original disconnect regression timed out on Bun 1.3.2 under Windows. It passes under Bun 1.4.3 (12/12 tests in `tests/control-server.test.ts`); an independent native Node TCP disconnect test passes in `tests/native-node-disconnect.node.cjs`. The control server listens for socket close after a completed request body and correctly uses the *response* close event for NDJSON subscribers. Never treat `IncomingMessage.close` as proof that an active response subscriber disconnected.
- **Lane ownership:** Creation, pairing, and turn-renewal remain on primary; only already-paired ordinary offline messages/goals from the one exact canary task are eligible for secondary. After pairing, the original browser releases its reservation before the secondary worker takes over. Routing is deterministic and never shifts revenue tasks by hashing or round-robin.
- **Lifecycle:** The second companion must be independently pre-launched with its own private browser home, descriptor and signed-in profile. The canary executor never invokes the primary lifecycle manager to restart the second process. Startup canonicalizes and rejects overlapping physical profile roots and duplicate descriptors. A stopped/unavailable second browser fails the canary before Send rather than touching the production Chrome profile.
- **Fencing:** The primary companion must also advertise the shared Send gate when a second lane is configured. Lane 2 additionally checks independent process IDs, matching paired account fingerprints, and identical gate fingerprints. Timeout/retained-action reconciliation and approval checks use the owning lane descriptor; never recover a canary action from the primary companion's action ledger.
- **Follow-up tests:** Five pure Rust lane-affinity checks, four native Node tests (including real two-Chromium isolation), all 12 Bun 1.4.3 control-server tests, and Rust `cargo check --offline --bin codexify --jobs 1` pass. These are **source-level gates**, not permission to claim two live production workers are running.

**Not authorized here:** purchasing credits, creating multiple ChatGPT accounts, credential/session extraction, circumventing rate limits, changing recurring schedules, replaying ambiguous messages, or restarting productive agents merely to increase the queue count.

## Localized response-delivery timeout and accepted renewal recovery

- The existing installed browser companion already recognizes the exact Slovene ChatGPT alert
  `Čas za dostavo sporočila se je iztekel. Poskusite znova.`, as well as English
  delivery-timeout variants. This means the *previous assistant response* timed out:
  it does not establish HTTP 429 or an unsent user turn. The companion never
  clicks the app's `Poskusi znova` button or replays the accepted user message.
- Five isolated Chromium regression tests passed in
  `browser-companion/tests/response-delivery-timeout.node.cjs`: localization,
  app-owned alerts, no-ARIA alerts, quoted-text rejection, and unrelated errors.
- Read-only inspection of persisted automation states found ten active goals
  with a recorded accepted renewal Send and a handoff whose
  `reportComplete` flag was still false. The old supervisor's unconditional
  `if sendAccepted { continue }` bypassed its own read-only proof scan.
- The repaired supervisor always checks that exact handoff in ChatGPT before
  scheduling another turn. A confirmed handoff can progress to the next
  **distinct** continuation; an unverified handoff older than 30 minutes
  becomes visibly `Stalled` with its action ID and accepted-send record
  preserved. Repeated scans cannot replay the accepted message. A subsequent
  exact handoff proof clears only this special stalled warning.
- The proof scanner enforces an in-process, read-only inspection budget:
  at most one new handoff-navigation attempt globally per minute, and one
  attempt per handoff every ten minutes. The budget is not a Send retry
  budget, and it avoids a fleet of old accepted sends constantly opening
  ChatGPT tabs. Proof of a complete handoff remains mandatory for renewal.
- This is a **source-only fix** until the new Codexify native executable
  passes tests and is installed through an elevated, quiet, rollback-safe
  service update. It cannot retroactively guarantee that a timed-out ChatGPT
  response was generated. Manual recovery of any particular failed
  conversation still requires inspection of its exact final handoff.

## Tested independent Windows deployment transaction

- Owner-approved release path: `scripts/install-local-two-browser-upgrade.ps1`. It is
  **read-only by default**. `-PreflightOnly` shows all hard gates, and
  `-SelfTest` exercises atomic install/restore of executable, browser bundle
  and config against disposable files, including a rejected ambiguous canary.
- Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-two-browser-upgrade.ps1 -SelfTest`
  and then `... -PreflightOnly` from this repository. The self-test passes
  without Administrator rights, without touching the real service.
- The real command is `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-two-browser-upgrade.ps1 -Apply`,
  launched from an **independent Administrator PowerShell** when the worker
  fleet has been quiet for at least three minutes. The installer refuses to
  run from a child process of the service it will replace. Do not run this
  via the current God v5 MCP tunnel, since a service restart will terminate
  the same connection. An `-Apply` without an explicit canary key upgrades
  only the native binary, primary companion and shared gate; it does
  **not** start a second execution worker by itself.
- For a genuine two-lane canary, supply
  `-CanaryTaskKey <exact 64-character stable key>`. The installer checks
  that it corresponds to exactly one already paired, active, non-ambiguous
  task, without an unverified turn-renewal handoff; no revenue goal is
  automatically chosen or migrated. The independently signed-in second
  Chrome profile is reused, never cloned.
- The installer checks Administrator elevation, correct scheduled task,
  no recent competing worker activity, fresh native and companion candidates,
  matching Electron support files, shared gate availability, and browser
  authentication before it stages anything. It then backs up the **exact**
  old native executable, `app.asar`, and config with checksums, verifies
  worker/browser idleness again and confirms that no production file changed
  during staging (including **after** stopping the old service). It then atomically replaces
  those three files and restarts it. On failure it attempts a full rollback
  and records a durable receipt under `~/.codexify/backups/two-browser-*`.
- The disposable installer self-test also verifies that a concurrent config
  edit is rejected rather than silently overwritten, and that an ambiguous
  canary action cannot be selected. File-transaction tests do not establish
  that a production service restart is safe; an independent Administrator
  session and a quiet fleet remain mandatory.
- Verified separately: all **17** installed/candidate Electron support
  files are byte-identical, and an isolated launch of the installed Electron
  executable with the new candidate `app.asar` passed the packaged smoke
  check using the exact current Codexify protocol build. No profiles,
  cookies or account data were copied.
- As of this implementation, the live Windows connector runs **without
  Administrator elevation**, so an intentional `-Apply` test rejects
  maintenance before stopping or modifying the service; installed binary
  SHA remains unchanged. Native recovery tests 38/38 passed, and the local
  source-derived candidate exists, but a source build is **not** a deployed
  repair. Ten hourly scheduled automations remain enabled. Waiting for a
  separately elevated quiet maintenance window is an actual hard gate, not
  an invitation to bypass Windows permissions.

## Late November 15 live recheck and post-restart safety fix

- Read-only preflight found the local candidate and companion fresh and
  runtime-compatible, both browser processes distinct, idle, authenticated,
  and on the same verified account. The running Windows service remained on
  the older native executable. `AdministrativelyElevated=false` and
  `FleetQuiet=false` prevented guarded maintenance. A canary key was not
  configured and the old primary did not yet expose the shared Send gate.
- The owner-chat activity API still reported other workers performing tools
  during the three-minute quiet window. All ten Revenue Shot hourly tasks
  remained enabled. No release, service stop, queued-send replay, or task
  schedule change was attempted.
- Fresh tests passed: five lane-affinity unit cases, four turn-renewal cases,
  two cross-process Send-gate tests, and the guarded install/rollback self-test.
  The installed binary still differed from the candidate; `/health` was `ok`.
- Post-restart authentication verification no longer requires the browser to
  have zero active actions. New work can start after the service is brought
  back; an authenticated, ready browser doing productive work must not cause
  an unnecessary rollback. The **pre-install** idle and fleet-quiet guards
  are unchanged. The self-test was run red/green against this regression,
  and separately rejects unauthenticated or unavailable browser status.
- Next genuine activation requires an independent Administrator PowerShell
  after an actual three-minute quiet window. Without a specific, already
  paired, noncritical `-CanaryTaskKey`, installation enables the new binary
  and shared gate but leaves the second execution lane disabled. Do not
  auto-select a revenue goal or infer success from enabled schedules.

## FleetQuiet wait option following owner's guarded install attempt

- The owner ran `-Apply` from Administrator PowerShell and received
  `Installation gate is closed: FleetQuiet` before any production swap. A
  read-only live owner-API check found recent activity in `mcp-geo` and
  `ml-research`. The quiet gate is working, but staggered hourly tasks can
  make finding a safe maintenance window inconvenient.
- The installer now accepts `-Apply -WaitForFleetQuiet -WaitTimeoutMinutes 60`
  (timeout bounded to 1-120 minutes). This opt-in foreground loop waits only
  while the *existing* owner-API gate reports active workers, checks every
  15 seconds, and surfaces the blocking workspace names. It does not create
  or reserve a quiet window, pause schedules, stop service processes, or
  relax the required three-minute inactivity rule. An unavailable owner API
  or any other preflight failure aborts rather than proceeding.
- After observed quiet, the installer runs the entire read-only preflight
  again, then the existing canary/backup/staging checks, and another fleet
  and browser-idle verification immediately before shutdown. An unrelated
  worker starting meanwhile closes the gate again. On wait timeout, the
  installer aborts without staging anything. Run only from an independent
  elevated console, not this connector (which is owned by the service).
- The isolated `scripts/test-two-browser-fleet-quiet-wait.ps1` exercises
  busy-to-idle success, API/owner verification refusal, deadline expiry,
  and initially idle behavior without contacting live worker state. Use
  it alongside the installer's existing `-SelfTest` fixture.

## Live guarded-upgrade failure after FleetQuiet and process-identity fix

- The owner used the new `-WaitForFleetQuiet` option and obtained
  `FLEET_QUIET_CONFIRMED`. After backing up production, the installer stopped
  the browser companion and disabled the scheduled service. It freed a
  verified port-3000 orphan PID 20792, then a verified service PID 7904. A
  second snapshot PID 11188 **changed identity** between enumeration and
  termination, so the installer correctly refused to kill it and restored
  service operation. The failure occurred **before** any native, browser or
  configuration file replacement. The failure backup is under
  `.codexify/backups/two-browser-20261115-223846`.
- Independent live checks after that attempt: Codexify Task Scheduler task
  running, HTTP `/health` status `ok`, installed native SHA-256 still
  `B8136AC54B4697AA4A009AE37850B4103D0055767C79DD99C5BB5F51420F50CF`,
  candidate native SHA-256 still
  `A65083AE1A6EFCA14522D9B3D57EE6546D720A44278332A5A5793FF292F34037`.
  Installed native, browser `app.asar` and configuration files matched the
  files staged in the failure backup; no deployment took place.
- Repaired `WaitForVerifiedServiceProcessesExit`: a process that exits or
  changes identity after snapshot is **never terminated** using a stale PID.
  Creation timestamp now joins executable path and exact command line in
  identity verification, so even PID reuse by another process with an
  identical command line cannot silently pass. A skipped PID is not assumed
  to be cleaned up: the installer still requires a fresh executable-wide
  scan showing **zero** installed native processes before replacing files.
  If another Codexify process actually persists, installation still aborts;
  the mismatch does not bypass the safety gate.
- New isolated mocked regression `scripts/test-two-browser-orphan-race.ps1`
  initially failed on the reported race, then passed five scenarios: normal
  orphan cleanup, unrelated PID reuse, vanished service, same-executable
  changed command, and same-command PID reuse with a different creation time.
  Also passed FleetQuiet tests, atomic installer/rollback self-tests and
  PowerShell syntax checks. The fix has **not** been deployed to the running
  Codexify service; the owner must run the guard-equipped installer again
  from independent Administrator PowerShell when a quiet window reappears.

## PrimaryAuthenticatedIdle retry and disabled-lane verification

- An independent Administrator `-Apply -WaitForFleetQuiet -WaitTimeoutMinutes 60`
  attempt next returned `Cannot wait for FleetQuiet while other installation
  gates are closed: PrimaryAuthenticatedIdle`. This was a preflight refusal:
  no files were staged or service stopped. Subsequent read-only primary health
  showed `status=idle`, `authenticated=true`, no active action, demonstrating
  transient activity rather than an expired login. The previously configured
  second companion did not respond to its own localhost health endpoint.
- The opt-in bounded maintenance wait now polls *all* read-only preflight
  gates until the fleet is quiet for three minutes **and** the primary is
  both authenticated and idle. Only a verifiably authenticated busy primary
  (`status=busy` or a nonempty activeActionId) is treated as waitable; unknown,
  unavailable, unauthenticated, or inconsistent browser state still aborts
  immediately. Missing owner-API evidence is explicitly distinguished from
  workers being busy and fails closed. Any other installation gate error also
  aborts without installing. A full preflight runs again before shutdown.
- With **no canary enabled**, an offline lane-2 companion is noncritical to
  the native+primary Send-gate upgrade. The preflight treats its absence as a
  disabled activation capability rather than a maintenance failure; after
  restart the installer verifies the primary account and Send gate instead
  of unconditionally requiring two live browsers. The second execution lane
  stays disabled. With an actual canary key, two distinct authenticated
  browser processes and matching Send gate fingerprints are still mandatory.
- The modified `scripts/test-two-browser-fleet-quiet-wait.ps1` covers
  asynchronous fleet/primary readiness, primary busy, unknown primary and
  owner API, unrelated gates, bounded timeout and immediately idle behavior.
  New `scripts/test-two-browser-optional-secondary.ps1` covers optional
  offline companion, strict canary gate, healthy primary Send gate and
  enabled dual-lane verification. These tests and the original PID/rollback
  cases pass without modifying running service or worker schedules.
- The wrapper also clears the read-only helper's expected exit code `2`
  after parsing its diagnostic JSON; `-PreflightOnly` itself now exits `0`
  when it successfully reports missing **activation** prerequisites. Live
  read-only verification confirmed `NativeCandidateFresh=true`,
  `BrowserCandidateFresh=true`, installed original binary intact and
  `/health` returning `ok`. The deployed browser runtime has NOT yet been
  replaced and the secondary execution lane remains disabled.

## Recovery from transient primary-browser `unavailable` states

- A later elevated `-Apply -WaitForFleetQuiet -WaitTimeoutMinutes 60` waited
  repeatedly for fleet quietness and primary idle, then exited before any
  service change with `PrimaryAuthenticatedIdle is closed, but the primary is
  not verifiably authenticated and busy`. The predicate was overly narrow:
  `ChatGptDriver.health()` can return `authenticated=true,status=unavailable`
  while the account is verified but ChatGPT temporarily has no unique usable
  composer or displays session-attention UI. This is not evidence that a Send
  is safe, but it is a reasonable *passive waiting* condition. A companion
  process can also restart/rotate its descriptor during an extended wait.
- A read-only live audit after the failure found healthy native `/health`,
  the original installed SHA unchanged, and four consecutive primary health
  samples reporting `authenticated=true,status=idle,activeActionId=null`.
  The companion process had started at 23:31:21 local during the owner's
  extended wait; precise cause of that restart was not established.
- Preflight now reports `PrimaryBrowserStatus` (`idle`, `busy`, `unavailable`,
  `authentication_required`, `probe_unavailable`, or `companion_missing`)
  without emitting credentials. It continues to require an authenticated
  account fingerprint to positively classify idle, busy or temporarily
  unavailable. A failed local companion health probe becomes an explicit
  *unknown* status, never an implicit success.
- `WaitForQuietFleet` now passively waits for a signed-in `unavailable`
  browser to recover within the overall owner-set maintenance timeout. A
  temporarily missing/unreachable/unauthenticated-unavailable companion is
  given at most **180 seconds of consecutive unknown health** before an
  explicit abort; a verified busy or unavailable companion resets that
  grace counter. An explicit `authentication_required` state aborts promptly.
  This relaxation applies to waiting **only**. Before replacement the original
  authenticated-idle gate, owner-verified three-minute fleet-quiet gate, and
  process/Send-lock checks must all pass; otherwise no production swap occurs.
- Targeted test cases were first run against the old predicate to reproduce
  the abort, then passed after the patch: authenticated unavailable then idle,
  temporary unreachable health then idle, 180-second unknown-state expiry,
  explicit sign-in requirement, and previous fleet/security/timeout cases.
  Optional secondary-browser, stale-PID and atomic rollback fixture tests
  still passed. No production task or worker was modified by this source fix.

## `busy` with an unverified account, and fleet starvation

- Another independent Administrator install attempt waited through over 30
  successive maintenance-window reports, predominantly `FleetQuiet`, with
  occasional `primary=busy` and one `primary=probe_unavailable`. It ultimately
  aborted before any service change on `PrimaryAuthenticatedIdle is closed with
  an unexpected or unauthenticated browser state: busy`.
- Source confirms `BrowserWindow.health()` emits `status=busy` whenever a
  browser operation is active, even if `ChatGptDriver.health()` cannot verify
  account identity during navigation. The combination `status=busy` and
  `authenticated=false` is therefore plausible and NOT proof of sign-out.
  Conversely, it is NOT safe to install on this state, since the Send may
  still be active. This is a wait-only classification error.
- The installer now allows `busy` with unverified authentication to recover
  passively, under the same hard 180-second consecutive-unknown grace as a
  temporarily unreachable primary. Once authenticated busy/unavailable is
  verified, the grace resets. An explicit `authentication_required` remains a
  hard refusal, and the actual replacement path still mandates fresh proof
  of `PrimaryAuthenticatedIdle`, `FleetQuiet`, and an unheld shared Send lock.
  The maintenance progress output includes a non-secret `account_verified`
  boolean to distinguish busy actions from temporary authentication uncertainty.
- The wait regression was run against the old predicate (RED) and the new
  predicate (GREEN), including an unverified busy browser transitioning to
  authenticated idle and the strict 180-second grace helper. The existing
  optional secondary, PID identity, and rollback fixtures still passed.
- A live read-only inventory found **ten enabled hourly Revenue Shot tasks**
  staggered at minute :00, :05, :10, :15, :20, :25, :30, :35, :45 and :50,
  plus other active project chats. When these jobs run tens of minutes, they
  overlap and can starve the three-minute global quiet condition. Changing
  browser retry classifications alone does not create a maintenance window.
  A reliable production rollout needs an explicitly owner-approved, reversible
  pause of new automated wakes, letting already-active work finish before
  the guarded installer runs, followed by verified restoration of all paused
  schedules. Do not silently disable tasks or bypass the fleet-quiet gate.

## Explicit owner-authorized forced maintenance

- On 2026-11-16 the owner explicitly approved interrupting current workers
  and requested one force command rather than waiting for all of the staggered
  hourly schedules to become quiet. A dedicated installer switch is therefore
  available: `-Apply -ForceMaintenance` in an **independent Administrator
  PowerShell**, without `-WaitForFleetQuiet`.
- Force maintenance waives **exactly** the `FleetQuiet` and
  `PrimaryAuthenticatedIdle` installation preflight gates; it does not waive
  elevation, candidate native/browser freshness, runtime compatibility,
  scheduled service presence, or the `SharedGateNotHeld` gate. An already-held
  shared Send lock remains a hard stop even in forced mode. With an explicit
  `-CanaryTaskKey` owner selection, force maintenance can now activate exactly
  one canary, but only when the secondary is authenticated and idle, uses a
  distinct live process on the same verified account, and advertises the
  identical cross-process Send gate. The canary's persisted ownership, active
  goal, reconciled handoff, and non-ambiguous action state are checked both
  before staging and immediately before service shutdown. A missing or
  mismatched condition aborts without weakening the force-install guard.
- When the native candidate and browser `app.asar` already have the same
  SHA-256 as the installed runtime, canary activation updates **only the
  configuration**, using a staged atomic replace after the service is stopped.
  This avoids replacing an `app.asar` still open in the independent secondary
  companion. Its rollback restores only the saved configuration and verifies
  that the untouched native and browser checksums still match the backups.
  A full three-file transaction remains for genuine runtime upgrades.
- Force mode does not probe the primary for idle before shutdown. Instead,
  after backups, staged checksums, and another complete (force-filtered)
  preflight, it disables the scheduled service **first**, then stops the
  browser companion for restart, preventing the service from relaunching that
  companion before the native/browser/config replacement. Exact service
  process identity verification, original-file backup checks, atomic replace,
  service health, authenticated primary Send gate and rollback remain required.
- Current workers may lose in-flight tool or browser actions. Owner-chat
  history, journals, pending handoffs and task schedules are not erased or
  resubmitted by the installer; uncertain accepted Sends must be reconciled
  before retry, not blindly replayed. The ten hourly automations remain
  enabled for their ordinary subsequent wakes. This is an authorized service
  interruption, **not** an automatic worker-resume or two-lane activation.
- Offline tests in `scripts/test-two-browser-force-maintenance.ps1` verify
  the two permitted gate exceptions, refusal of each representative hard
  gate, normal-mode strictness, primary-idle probe handling, selected canary
  authentication/account/Send gate checks and fresh state revalidation,
  and supervisor-first shutdown ordering. All existing race,
  fleet-wait, optional secondary, and atomic rollback tests were re-run.

## Race between selected canary activity and activation (2026-11-16)

- An owner-run elevated `-Apply -ForceMaintenance -CanaryTaskKey <GSC key>`
  safely aborted **before backup or service shutdown** with `Canary has an
  unresolved in-flight or delivery-failure action`. The GSC goal had been
  idle in earlier preflight, but its hourly runtime resumed work before the
  owner started the installer. A subsequent read-only inspection observed an
  active, verified GSC goal with `queued`/`sendAccepted=false`, no unreconciled
  handoff and a healthy service. The refusal was a legitimate timing race,
  not evidence that account identity or shared Send admission failed.
- `-Apply -ForceMaintenance -WaitForCanarySafe -WaitTimeoutMinutes 20
  -CanaryTaskKey <exact key>` now passively polls that **one** goal until it
  has a verified `idle` or unsent `queued` action, without interacting with
  any ChatGPT tab. Only `navigating`, `sending` and `generating` are waitable.
  `ambiguous`, `failed`, `rate_limited`, `interference`, `stalled`, `cancelled`,
  unknown states, unverified ownership or unfinished renewal handoffs abort
  promptly; the wait has an absolute deadline. Neither accepted Sends nor
  action records are cleared/replayed, and existing readiness checks remain.
- The canary safety check repeats **after file staging**, with another full
  preflight, and finally **after the native service has stopped**, before
  installing the new config. A race detected that late causes restoration of
  the original service without applying canary routing. Pre-stop failures no
  longer issue an unnecessary `browser start` against a healthy primary.
- `scripts/test-two-browser-canary-safe-wait.ps1` covers transient status
  recovery, hard failure states, unreconciled ownership, unsafe queued Sends,
  bounded timeout and source wiring of the three canary checks. No testing
  directly changes live automation states or initiates a Send.

## Repeated blank tab creation during blocked conversation loads

- Root cause: `ChromeSingleWindowSurface.selectConversation` opened a new
  background tab before `navigatePage` checked the shared ChatGPT load
  cooldown. A rejected navigation closed the blank tab in its catch handler.
  The automatic handoff recovery scanner repeated this pattern, causing
  visible tab open/close flicker and needless Chrome targets.
- `assertConversationLoadAvailableBeforeTab` uses the existing shared budget
  and honors explicit manual cooldown bypass. The original guard inside
  `navigatePage` remains authoritative after the asynchronous tab creation;
  there is no additional Send or navigation allowance. A rejected retry now
  leaves the selected page and browser target count unchanged.
- `browser-companion/tests/chrome-surface.test.ts` verifies suppressed blank
  targets, unchanged selected tab, same-conversation reuse, and allowed
  explicit manual navigation. Browser surface/navigation/renewal tests passed
  34 cases (4 real-Chrome opt-in tests were skipped), and TypeScript checked.
- The browser-only fix is compiled and staged into the existing candidate
  `browser-companion/release/win-unpacked/resources/app.asar`, leaving the
  installed production ASAR and Chrome profiles unchanged. The original
  candidate is backed up under `browser-companion/artifacts/candidate-backups/`.
  `browser-companion/scripts/stage-tab-churn-asar.cjs` restores the existing
  packaged dependencies then replaces only the new compiled `dist/main.js`.
- `scripts/apply-tab-churn-fix.ps1` provides a read-only preflight by default
  and an opt-in independent elevated `-Apply -ForceMaintenance` operation.
  It checks both authenticated companions and their shared Send gate, requires
  idle secondary, stops only the verified secondary process tree, invokes the
  previously tested rollback-capable native installer, and relaunches the
  secondary with its existing separate profile. This does **not** activate
  lane-2 task routing or automatically reconcile accepted handoffs.

## Actual scheduling versus requested two-worker round robin

- Current native code has **one shared queue**, a primary consumer, and an
  optional **single-key canary** consumer. Only the explicitly assigned goal's
  offline actions may run on the second companion; creation, pairing and
  turn renewal remain primary. The deployed config has no canary key, so
  lane 2 is idle even when its browser is authenticated.
- A goal stays active across multiple ChatGPT turns, while each eligible
  queued action runs on one lane at a time. The existing code does not yet
  provide two general-purpose fair work pools or automatically rotate all
  ten revenue goals between them. Such routing must first preserve each
  conversation's pairing and accepted-Send ownership, and require a live
  two-lane concurrency test before enabling broad production distribution.
- A fresh non-revenue goal (revision 1) was created in the reliability-lab
  conversation using `goal_set`, but genuine pairing is absent; it is not
  eligible as a canary yet. Creating an eleventh scheduled ChatGPT automation
  was rejected with `too_many_active_automations` (10/10 slots occupied).
  No revenue schedule or pairing state was modified to manufacture capacity.

## Exactly two isolated pilots (2026-11-16)

- At user request, paused **all 10 existing hourly Revenue Shot automations**
  through the ChatGPT automation management API (every update confirmed).
  None was deleted and their accepted Sends, journals, goals and branches
  were left unchanged. Created only two hourly non-revenue pilot schedules:
  `Codexify Lane 1 Pilot` at 10:15 Europe/Ljubljana and `Codexify Lane 2 Pilot`
  at 10:20, staggered five minutes, under the plan's 10-slot limit. A manual
  immediate-run request returned inline to the initiating conversation, **not**
  two new paired tasks; pairing must be independently verified from the real
  scheduled conversations before production routing can be activated.
- Added opt-in `agentChat.automation.pilotPrimaryTaskKey` (distinct exact 64-char
  key required alongside `canaryTaskKey`). Native startup builds an explicit
  two-task pilot: scan skips legacy goal/handoff/approval activity **without
  rewriting state**, both queues exclude all other keys, primary owns all
  actions of the primary pilot plus pairing/renewal for the selected canary,
  and secondary owns only selected canary offline chat/goal turns. The shared
  atomic cross-process Send gate still serializes accepted Sends; one primary
  goal and one secondary goal can be independent while previous states stay
  conservatively frozen.
- The guarded elevated installer accepts `-PilotPrimaryTaskKey <key>` together
  with `-CanaryTaskKey <other-key>`; revalidates both genuinely paired active
  goals before staging, after staging, and after native service shutdown.
  A native-only upgrade avoids replacing the Electron ASAR when its hash
  already matches the installed runtime (important while secondary is live).
  Installer rollback and refusal on ambiguous accepted Sends remain in place.
- **Activation gate:** Until each scheduled pilot gets its own unique local
  automation.json state with verified owner pairing and no unconfirmed renewal
  handoff, do not configure either task key, restart the service, or declare
  concurrent success. Never use the unpaired existing reliability-lab goal as
  a substitute for a genuinely paired new ChatGPT scheduled conversation.
