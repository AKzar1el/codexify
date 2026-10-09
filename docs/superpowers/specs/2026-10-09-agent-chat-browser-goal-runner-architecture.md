# Agent Chat Browser Automation Architecture

**Status:** Revised draft for user validation

**Date:** 2026-10-09

**Upstream reference:** `miuuyy/codex-chatgpt-web` tag `v6.1.7`, commit `f9ad4ae`

**Codexify baseline:** `v1.7.0`, commit `f269d56`

## 1. Objective

Add optional browser automation to Codexify's standalone agent-chat page without
turning ChatGPT Web into a Codex model provider.

The automation is an **offline fallback for the existing agent chat**, with goals
as an optional additional source of work:

- While the agent is online, Codexify behaves exactly as it does today. Messages
  written in the standalone chat are appended to `CHAT.md` and are surfaced
  opportunistically in ordinary Codexify tool results or through
  `chat_read`/`chat_write`/`chat_await`.
- Once the task becomes offline according to Codexify's existing presence rule,
  unread standalone-chat messages may be copied into the paired ChatGPT
  conversation through a browser harness.
- An active goal may also wake an offline task even when no new chat message is
  pending.
- If unread messages and an active goal coexist, one browser message carries both
  purposes. It asks the model to process the chat input, evaluate the goal, mark
  it complete or blocked when appropriate, and otherwise continue working.
- The visible ChatGPT assistant response is streamed back into the standalone
  Codexify chat while that browser-driven turn is running.
- With no paired ChatGPT URL, browser automation is unavailable for that task;
  ordinary agent chat continues to work.

The ChatGPT web models must **not** appear in Codex, Codex's model picker, its
Responses provider, or its model catalog. Codexify remains an MCP connector,
agent-chat server, and task-state owner. The browser companion is a separate,
optional control plane.

## 2. Key behavioral rules

1. **Online means no browser intervention.** A configured goal or unread chat
   message does not by itself justify touching ChatGPT. The existing agent-chat
   delivery path remains authoritative while the agent is online.
2. **Offline uses the existing definition.** Browser eligibility uses the same
   task-scoped last-model-tool-activity state and five-minute offline threshold
   that currently drive agent-chat presence. It does not introduce a competing
   automation-specific notion of offline.
3. **Ordinary chat does not require a goal.** An unread standalone-chat message is
   sufficient work to wake an offline, paired task.
4. **Goals do not require a separate evaluation turn.** The next offline wake-up
   asks the model to evaluate the active goal in the same prompt that resumes
   work.
5. **The user supplies the conversation URL.** Codexify never infers the ChatGPT
   conversation from recency, browser history, project placement,
   `openai/session`, page order, or another heuristic.
6. **Existing conversations are reused.** Automation does not create a replacement
   ChatGPT conversation, migrate the task, retire the manual conversation, or
   transfer stable-task ownership merely to automate it.
7. **One browser window is shared.** The companion owns one long-lived authenticated
   ChatGPT window and serializes work for every Codexify task through it. It does
   not retain one tab per task.
8. **Browser output is a fallback stream, not a second tool protocol.** Tool calls
   continue through the existing Codexify connector exactly as they do during
   manual ChatGPT use.

## 3. Non-goals

The first implementation will not:

- proxy the OpenAI Responses API;
- add `(Web)` model rows to Codex;
- rewrite Codex configuration or intercept Codex model requests;
- create or choose a ChatGPT conversation through a “most recent” heuristic;
- create a new ChatGPT conversation automatically for an existing task;
- transfer, alias, or retire physical ChatGPT conversation ownership;
- keep a browser tab or `WebContentsView` alive per Codexify task;
- navigate the shared browser away from a generating response;
- inject new owner-chat messages into an already generating ChatGPT turn;
- auto-approve ChatGPT tool actions by default;
- silently switch model, effort, connector, or conversation after verification
  fails;
- retry an ambiguously accepted ChatGPT submission;
- evade ChatGPT rate limits or account restrictions;
- import the upstream project's Responses bridge, Codex model catalog, context
  compiler, compaction engine, subagent protocol, MCP tunnel, or Codex integration
  journal.

## 4. Source analysis

`codex-chatgpt-web` solves a broader problem than Codexify needs. Its useful
browser layer already contains hardened implementations for:

- a persistent authenticated Electron browser partition;
- Playwright/CDP attachment through a private loopback descriptor;
- account capability inspection;
- ChatGPT model-family and reasoning-effort selection;
- verification that the requested model and effort survived menu closure;
- connector selection in the ChatGPT composer;
- exact composer insertion and pre-send verification;
- semantic Send acceptance detection;
- logical turn binding through stable ChatGPT turn identities;
- visible response extraction and stable Markdown conversion;
- completion, error, rate-limit, approval, and login observation;
- ambiguous-submission handling;
- selector-drift failures that stop before an unsafe send.

The relevant upstream modules are primarily:

```text
src/chatgpt-session.ts
src/chatgpt-web-models.ts
src/adapters/chatgpt-web/model-selection.ts
src/adapters/chatgpt-web/browser-worker.ts
src/adapters/chatgpt-web/markdown.ts
src/adapters/chatgpt-web/turn-execution.ts
src/adapters/chatgpt-web/turn-progress.ts
src/adapters/chatgpt-web/launcher-helper-client.ts
src/launcher-browser-host.ts
launcher/electron/browser-host.cjs
launcher/electron/control-server.cjs
```

The upstream repository is MIT-licensed. Substantial copied or derived code must
retain the MIT notice and be listed in Codexify's third-party notices.

The intended extraction deliberately changes one major upstream assumption:
`codex-chatgpt-web` can retain several task-bound tabs, whereas Codexify will own
one shared window and navigate it only between serialized automation actions.
The selector, submission, response-binding, and failure logic should be reused;
the multi-tab leasing architecture should not.

## 5. Alternatives considered

### 5.1 Import the complete upstream application

This would bring a working browser quickly, but also a Responses proxy, Codex
model catalog, Codex configuration journal, compaction engine, tunnel broker,
launcher UI, and independent task model.

**Rejected.** Codexify would inherit two competing orchestration systems and a
large unrelated maintenance surface.

### 5.2 Reimplement the browser harness in Rust

This would simplify the language boundary, but would require reproducing
Playwright semantics, Electron login behavior, dynamic selectors, exact model
verification, turn binding, streaming Markdown extraction, and a large browser
regression suite.

**Rejected.** It discards the most valuable and tested part of the upstream
project.

### 5.3 Extract a narrow TypeScript/Electron browser companion

Vendor only the browser/session logic needed by Codexify behind a small,
versioned, authenticated loopback protocol. Rust remains authoritative for task
identity, URL pairing, unread chat state, goals, offline detection, scheduling,
persistence, and policy. The companion owns the Electron profile and ChatGPT DOM.

**Selected.** It reuses the upstream edge-case handling without exposing Web
models in Codex or importing its Responses architecture.

### 5.4 Retain one browser tab per task

Keeping every mapped conversation resident would avoid navigation latency, but
would consume memory, complicate browser ownership, make manual interference
harder to detect, and scale poorly with long-lived Codexify chats.

**Rejected.** A single serialized window is sufficient because browser automation
is used only after a task is offline.

## 6. High-level architecture

```text
                    online path: unchanged

┌────────────────────┐       MCP connector       ┌──────────────────────────┐
│ User's ChatGPT     │ ─────────────────────────▶│ Codexify MCP server      │
│ conversation       │                           │                          │
└────────────────────┘                           │ stable task identity     │
                                                 │ CHAT.md + read cursor    │
                                                 │ existing tool dispatch   │
                                                 │ goal + automation state  │
                                                 └────────────┬─────────────┘
                                                              │ private RPC
                                                              │ queued actions
                                                 ┌────────────▼─────────────┐
┌────────────────────┐      authenticated API    │ Browser companion       │
│ Standalone         │ ─────────────────────────▶│                          │
│ Codexify chat      │                           │ one Electron window     │
│                    │◀──── streamed output ─────│ one serialized queue    │
│ ordinary composer  │                           │ Playwright harness      │
│ URL/model/goal UI  │                           │ exact URL navigation    │
└────────────────────┘                           └────────────┬─────────────┘
                                                              │ HTTPS/UI
                                                 ┌────────────▼─────────────┐
                                                 │ chatgpt.com              │
                                                 │ user-paired conversation │
                                                 └──────────────────────────┘
```

Codexify has two delivery paths for the same agent chat:

1. **Online opportunistic path** — unchanged. Pending user text is appended to
   ordinary Codexify tool results or consumed through chat tools.
2. **Offline browser path** — only after the same task becomes offline. Codexify
   mirrors a bounded pending batch into the explicitly paired ChatGPT conversation
   so the model wakes up and calls Codexify again.

The second path is a fallback for the first, not a separate conversation model.

## 7. Core terminology and invariants

### Stable task

The Codexify task identity that owns workspace binding, `CHAT.md`, memory, diff
checkpoints, command sessions, and goal/automation state.

### Physical ChatGPT conversation

The ChatGPT conversation currently making connector calls. Its opaque
`openai/session` identity is useful inside Codexify but is not a browser URL.

### Paired URL

A user-supplied ChatGPT conversation URL stored against one stable task. It is
private state. It is never inferred from connector metadata.

### Online and offline

The existing task-scoped presence state derived from the last model-visible
Codexify tool call. The first version reuses the existing five-minute offline
threshold exactly.

### Offline action

One serialized browser operation for a task. It may carry:

- unread ordinary chat messages;
- an active-goal continuation/evaluation instruction;
- or both.

### Invariants

- A task has at most one paired URL.
- A paired URL does not change task ownership.
- One shared browser action runs globally at a time.
- The browser never navigates away while ChatGPT is generating.
- Pending messages remain in `CHAT.md` until existing chat consumption advances
  the read cursor.
- A browser mirror does not itself acknowledge or consume those messages.
- One accepted browser action is never resent automatically after ambiguous
  acceptance.
- No private chat content is sent before URL pairing has been verified against the
  intended stable task.

## 8. Component boundaries

### 8.1 Rust `AgentAutomationStore`

A new task-scoped store owns persistent automation state. It is keyed by stable
task identity.

Responsibilities:

- store the user-supplied ChatGPT URL and canonicalized verified URL;
- store the owner-generation against which the URL was verified;
- store selected browser model route and reasoning effort;
- store optional goal state and monotonically increasing goal revision;
- store unread-message mirror batches and idempotency IDs;
- store the latest browser action state and stable streamed output;
- store goal-only nudge deduplication state;
- invalidate queued work after URL, owner generation, model, effort, or goal
  revision changes;
- serialize owner API and MCP mutations;
- recover conservatively after restart.

It does not inspect the ChatGPT DOM or choose selectors.

### 8.2 Rust `AgentAutomationSupervisor`

A server-owned supervisor coordinates all mapped tasks and owns the single global
browser-action queue.

Responsibilities:

- consume the existing task activity/presence stream;
- observe pending unread agent-chat messages;
- decide when a task is offline and has actionable work;
- coalesce new messages for the same task while an action is queued;
- prioritize unread-chat actions over goal-only continuation nudges;
- send idempotent companion requests;
- consume browser progress and assistant-output events;
- correlate post-send Codexify activity with the expected stable task;
- persist stable fallback output when needed;
- surface task-specific status in the standalone page;
- recover without replaying an ambiguously accepted Send.

It does not parse hidden model reasoning or execute browser selectors.

### 8.3 Browser companion

A separate TypeScript/Electron process owns browser-sensitive behavior.

Responsibilities:

- keep one persistent authenticated ChatGPT partition and one long-lived window;
- expose login and account-capability inspection;
- navigate the one window to an exact user-paired URL;
- prove that the expected conversation surface and composer are present;
- select and verify the exact model family and effort;
- select and verify the configured Codexify connector;
- insert one bounded automation prompt into an empty owned composer;
- verify semantic send acceptance;
- bind and observe the resulting assistant turn;
- stream visible stable status/commentary/answer segments to Codexify;
- report completion, approval, authentication, rate limit, drift, cancellation,
  ambiguous acceptance, and external interference;
- reveal the shared browser window on explicit user request.

It does not read project files, `CHAT.md`, goals, memory, or Codexify credentials
except for the bounded operation data sent through its private RPC.

### 8.4 Standalone owner-chat UI

The standalone page gains an automation section. The embedded ChatGPT widget does
not gain browser controls.

The section contains:

- browser-companion health and login state;
- a ChatGPT conversation URL field with Pair, Verify, Replace, Unlink, and Open
  actions;
- model dropdown;
- effort dropdown filtered by the selected model and live account capabilities;
- online/offline presence and browser-queue state;
- goal editor, Run, Stop, Clear, and Status actions;
- current browser action and streamed output;
- explicit errors and repair actions.

The existing message composer remains the ordinary agent-chat composer. The page
calls only Codexify's authenticated owner API. Companion bearer credentials and
direct browser endpoints never enter page JavaScript, including when the owner
page is reverse-proxied through a custom hostname.

### 8.5 MCP goal tools

The agent-chat connector schema includes two narrow goal tools. Their operations
return an explicit disabled state unless agent-chat automation is enabled:

- `goal_read` — returns the active goal text, revision, and status;
- `goal_finish` — marks the expected goal revision `completed` or `blocked`.

`goal_finish(status="blocked")` requires a nonempty bounded explanation. A goal
cannot become blocked without the model recording why. A completed goal may carry
an optional bounded summary.

There is no `automation_attach` tool and no task-ownership transfer. URL pairing is
initiated by the user from standalone chat and verified without migrating the
task.

### 8.6 MCP pairing verification tool

Before private chat text can be mirrored into a newly paired URL, Codexify needs to
prove that the pasted browser conversation is already the physical ChatGPT
conversation associated with the intended stable task.

A small one-time tool provides that proof:

- `automation_verify_pairing` — consumes a short-lived random pairing reference
  and succeeds only when the calling physical conversation currently resolves to
  the stable task that issued it.

This tool **does not** grant general authorization, transfer task ownership,
retire another conversation, or expose the stable task identity. It only verifies
the user's explicit URL pairing.

The verification flow sends no project state, chat text, or goal text. Only after
it succeeds may the URL receive ordinary offline messages.

The tool does not bypass Codexify's existing setup gate. Pairing requires a
conversation that is already authorized for the task through the normal connector
flow.

Pair-verification browser output is operational setup feedback. It is not
streamed into or persisted as ordinary agent-chat conversation content.

## 9. Conversation URL pairing

### 9.1 Why explicit input is required

The connector receives an opaque ChatGPT conversation identity, not a browser URL.
ChatGPT projects, custom GPT surfaces, browser history order, and recently active
conversations make “most recent conversation” heuristics unsafe. Codexify therefore
never guesses.

The user pastes the exact conversation URL into the standalone task page.

### 9.2 URL validation

Codexify performs conservative syntactic validation before contacting the helper:

- HTTPS only;
- `chatgpt.com` origin only;
- no credentials;
- bounded length;
- no unsupported fragment;
- no attempt to decode or transform a conversation identifier.

Because ChatGPT may use different route shapes for ordinary conversations,
projects, or future UI revisions, Rust does not insist on only `/c/<id>`. The
companion opens the exact submitted URL and verifies a single authenticated
conversation surface with one usable composer. It returns the canonical URL after
ChatGPT navigation settles; query and fragment data not required to reopen the
conversation are discarded.

### 9.3 Pairing verification

Pairing is a one-time, explicit transaction:

1. The owner API stores the candidate URL in an unverified state and issues a
   random pairing reference whose digest is persisted.
2. The companion navigates the single shared window to that URL, verifies login,
   the conversation composer, the configured connector, model controls, and an
   empty owned draft.
3. It sends a tiny verification message containing no task content and instructing
   the model to call `automation_verify_pairing` with the one-time reference.
4. The tool call succeeds only if that physical ChatGPT conversation resolves to
   the stable task that owns the standalone page.
5. Codexify consumes the reference and records the canonical URL plus the current
   physical-owner generation.

If the URL points to another conversation or task, verification fails before any
private owner-chat message is copied there.

### 9.4 Owner changes

If the task later moves to a different physical ChatGPT conversation through the
existing continuation mechanism, the stored owner generation no longer matches.
The URL becomes unverified and browser automation pauses until the user supplies
and verifies the new conversation URL.

No conversation is retired or migrated by this automation feature.

### 9.5 Missing URL

If a task becomes offline with unread messages or an active goal but has no
verified URL:

- messages remain unread in `CHAT.md`;
- the goal remains active;
- no browser action is attempted;
- the standalone page shows **Pair the ChatGPT conversation to enable offline
  delivery**.

## 10. Ordinary chat behavior

### 10.1 Online task

When the task is online, behavior is unchanged:

1. the user message is appended idempotently to `CHAT.md`;
2. existing unread and receipt state is updated;
3. pending text is appended opportunistically to ordinary Codexify tool results;
4. `chat_read`, `chat_write`, and `chat_await` retain their existing semantics;
5. no browser action is queued, even when automation is enabled.

### 10.2 Offline task without a goal

When the task is offline and has unread user messages:

1. Codexify snapshots a bounded unread batch with stable message IDs;
2. if the URL is verified, an offline chat action is queued;
3. the shared browser waits until any earlier action finishes;
4. it opens the paired URL, verifies model, effort, connector, and empty composer;
5. it sends an exact copy of the unread message Markdown in a bounded envelope;
6. ChatGPT's visible response is streamed into standalone Codexify chat;
7. the model is instructed to call `chat_read` before acting so existing cursor and
   acknowledgment semantics remain authoritative.

Automatic batching excludes unread message IDs that were already accepted by a
previous browser action for the same owner generation. They remain unread until a
chat tool consumes them, but Codexify does not repeatedly mirror the same text.
An explicit user retry may override this deduplication.

A goal is not required.

### 10.3 Offline task with a goal but no unread message

When the task is offline and an active goal exists, Codexify queues a goal
continuation action. The prompt asks the model to call `goal_read`, evaluate the
current revision, and:

- call `goal_finish(status="completed")` if the goal is satisfied;
- call `goal_finish(status="blocked", reason=...)` if progress cannot continue;
- otherwise continue working.

This evaluation is part of the same wake-up. There is no separate “judge the goal”
turn.

### 10.4 Offline task with both unread messages and an active goal

One combined prompt contains the unread chat batch and the goal-control
instruction. Chat handling comes first; goal evaluation follows in the same turn.
Codexify does not send one prompt for the messages and another prompt for the goal.

### 10.5 Messages arriving during browser generation

New user messages are appended normally to `CHAT.md` but are never inserted into
an already generating ChatGPT response. They are coalesced into the next queued
action if the task is still offline after the current action settles.

## 11. Browser prompt contract

### 11.1 Pair verification

The verification prompt contains only:

```text
Verify that this ChatGPT conversation is paired with the intended Codexify task by
calling `automation_verify_pairing` with the supplied one-time reference. Do not
inspect project files or perform task work in this verification turn.
```

### 11.2 Unread-chat wake-up

The offline prompt contains a structured, bounded batch:

```text
The Codexify standalone chat has unread user messages. Their Markdown is mirrored
below so you can see why you were woken. Call `chat_read` before acting; the tool
result is authoritative and advances the existing read cursor. Treat matching
messages once, not once from this mirror and again from `chat_read`.

<codexify-unread batch="opaque-id">
<message id="opaque-id">...</message>
</codexify-unread>
```

Message text is escaped as data, not interpolated into hidden browser-control
instructions. The batch ID and message IDs allow diagnostics and deduplication
without logging message contents.

### 11.3 Goal clause

When a goal is active, the same prompt appends:

```text
This task also has an active Codexify goal. Call `goal_read` for the current
revision. If it is complete, call `goal_finish` with status `completed`. If work
cannot proceed, call `goal_finish` with status `blocked` and explain the concrete
blocker. Otherwise continue working toward the goal. Do not request a separate
turn merely to evaluate goal status.
```

### 11.4 No actionable work

If the task is offline but has neither unread messages nor an active goal,
Codexify sends nothing.

## 12. Browser response streaming and persistence

The upstream browser harness already distinguishes stable visible status,
commentary, and final-answer Markdown. Codexify reuses that observation layer.

During a browser-driven action:

- stable visible status/commentary may be shown as transient activity;
- stable assistant-answer Markdown is streamed incrementally into the standalone
  task page;
- hidden chain-of-thought, DOM metadata, cookies, HTML, and screenshots are not
  streamed;
- the embedded ChatGPT Codexify widget does not receive this stream.

`CHAT.md` remains the authoritative persisted user-facing transcript. To avoid
creating duplicate messages when the model also uses `chat_write`:

1. Codexify records the transcript revision when the browser action starts.
2. Browser answer Markdown is shown live but is not immediately appended.
3. When the turn settles, Codexify checks whether one or more agent blocks were
   appended through `chat_write` after that starting revision.
4. If `chat_write` produced output, that output remains authoritative and the
   browser final answer is retained only as automation diagnostics.
5. If no agent block was written and the browser exposes a stable nonempty final
   answer, Codexify appends it exactly once as an agent message tagged internally
   with the browser action ID.

Visible status/reasoning rows are never appended as agent chat messages. An
ambiguous or still-mutating answer is not persisted as final output.

Persisting or displaying browser output does not count as model-visible Codexify
tool activity, advance the chat read cursor, or make the agent appear online. Only
the existing dispatch/activity path does that.

This gives the user live browser output after offline takeover while preserving
existing `chat_write` behavior and avoiding doubled replies.

## 13. Goal commands and lifecycle

The standalone UI is primary. The chat composer also recognizes:

```text
/goal set <Markdown>
/goal run
/goal stop
/goal clear
/goal status
```

`//goal ...` sends a literal message beginning with `/goal`.

Recognized goal commands are handled locally before the ordinary send path and do
not enter `CHAT.md`.

### 13.1 Goal size

Goal Markdown is limited to **10 KiB of UTF-8 bytes**. The limit is checked before
persistence. Goal text is excluded from ordinary logs, audit previews, helper
diagnostics, and command-line arguments.

### 13.2 Semantics

- `set` stores a new configured revision. Editing always increments the revision.
- `run` marks the current revision active. If the task is online, it does not use
  the browser; the goal notice is surfaced through normal Codexify activity. If
  the task is already offline, the supervisor may queue a goal action.
- `stop` deactivates the current revision without claiming completion or blockage.
  The configured text remains available for another `run`.
- `clear` removes a configured, completed, blocked, or errored goal. It refuses
  while the goal is active unless the user stops it first.
- `status` is read-only.

There is no pause/resume state. A temporary lack of progress is either ordinary
continued work, an explicit user stop, or a model-reported blocked goal.

### 13.3 Completion and blockage

`goal_finish` requires `expected_revision` so an older browser turn cannot finish
a replacement goal.

- `completed` may include an optional summary.
- `blocked` requires a concrete nonempty reason; the tool rejects an unexplained
  blocked transition.

A browser final answer does not itself finish a goal.

### 13.4 State machine

```text
absent
  │ set
  ▼
configured ── run ──▶ active ───────────────▶ completed
    ▲                   │   │
    │                   │   └───────────────▶ blocked(reason required)
    │                   │
    └──── stop ◀────────┘
    │
    └──── clear ───────▶ absent

active ── unrecoverable state error ────────▶ error
```

The browser substate is separate:

```text
unpaired | unverified | queued | navigating | sending | generating | idle |
approval_required | authentication_required | rate_limited | interference |
ambiguous | stalled | failed
```

## 14. Offline detection and wake policy

Codexify already records stable-task model-visible activity and exposes the same
online/away/offline presence in embedded and standalone chat. Browser automation
must consume this existing state rather than duplicate it.

An automatic action is eligible only when all relevant conditions hold:

- automation is enabled;
- the task is offline under the existing five-minute rule;
- a verified conversation URL exists for the current owner generation;
- unread chat messages or an active goal exist;
- no browser action for the task is running or already queued with the same work;
- the single companion window is not generating another task's response;
- the goal revision, URL pairing generation, model, and effort still match the
  queued snapshot;
- the current message batch or goal-only activity epoch has not already been sent;
- ChatGPT is authenticated and the companion is healthy.

For unread messages, a new unread batch re-arms delivery even when no goal exists.
For a goal-only continuation, one automatic nudge is allowed per Codexify activity
epoch. Any later model-visible tool call advances activity and can create a future
offline epoch.

If an accepted goal-only wake-up produces no Codexify activity, the goal becomes
`stalled` for automation purposes. It remains active, but no repeated `continue`
loop is emitted until:

- the user sends another chat message;
- the user invokes `/goal run` again;
- or model-visible activity re-arms the task.

## 15. Shared browser queue

The companion exposes one window; Rust owns the multi-task queue.

### 15.1 Queue rules

- At most one browser action executes globally.
- Actions are validated again immediately before execution.
- Unread-chat actions outrank goal-only continuation actions.
- Multiple unread messages for the same queued task are coalesced when size limits
  permit.
- A task cannot occupy consecutive goal-only slots while another task has pending
  unread chat.
- Pair-verification actions contain no private task content and may run before
  ordinary queued work when explicitly requested by the user.
- Changing or unlinking a URL invalidates every queued action built from the old
  pairing generation.
- Changing model or effort invalidates queued but unsent actions.
- The queue never navigates away from a response that has not reached a terminal
  or safely cancelled state.

### 15.2 Manual interference

The user may reveal and inspect the shared browser. If the companion observes an
unexpected user Send, navigation, model change, connector change, or composer
mutation during an owned action, it reports `external_interference` and stops
before another automated Send. It does not overwrite the user's draft or attempt
to merge histories.

### 15.3 Several offline agents

If several mapped tasks become eligible, their actions wait in the Rust queue.
The one browser window visits each exact URL in turn. No background tab is kept
for the previous task.

## 16. Model and effort catalog

The Rust server does not hard-code current ChatGPT product labels as protocol
authority. The companion returns a live, versioned catalog, for example:

```json
{
  "catalogRevision": "opaque-revision",
  "models": [
    {
      "id": "gpt-6-sol",
      "label": "GPT-6 Sol",
      "efforts": [
        { "id": "medium", "label": "Medium", "available": true },
        { "id": "high", "label": "High", "available": true },
        {
          "id": "xhigh",
          "label": "Extra High",
          "available": false,
          "reason": "not_available_for_account"
        }
      ]
    }
  ]
}
```

The initial catalog may preserve the upstream route semantics for Luna/Think,
GPT-5.6 Sol, GPT-6 Sol, and Pro. These are browser-companion details, not Codex
model entries.

The task stores stable model and effort IDs. Before every physical Send, the
companion reopens the model controls, selects the exact family and effort, closes
the menu, and verifies the resulting ARIA/DOM evidence. A stale catalog or failed
verification stops before Send and asks the user to refresh capabilities.

Capabilities are tied to a privacy-preserving account fingerprint. If the logged
in ChatGPT account changes, paired URLs and capability observations become
unverified until setup is repeated. Codexify does not persist raw email addresses,
account names, cookies, or authentication tokens.

## 17. Connector schema and model instructions

The release adds `automation_verify_pairing`, `goal_read`, and `goal_finish` to
the agent-chat connector schema and gains an explicit marker such as
`+agent-automation-v1`. Their operations remain disabled unless
`agentChat.automation.enabled` is true, but toggling that local setting does not
change the advertised schema. This avoids making a later automation opt-in itself
invalidate an otherwise reusable manual conversation.

Upgrading to the schema version still requires the ordinary connector Refresh.
Pairing preflight checks tool visibility in the exact target conversation; if
ChatGPT has retained an older cached tool schema there, Codexify reports that host
limitation instead of creating or migrating a replacement conversation.

When a goal is active, `get_agent_brief` adds:

- call `goal_read` before goal work;
- continue using existing chat tools for owner communication;
- evaluate the current goal during each offline browser wake-up;
- call `goal_finish` only for the exact current revision;
- include a concrete reason when blocked;
- do not request an extra turn solely to assess completion;
- do not treat an ordinary final answer as goal completion.

The ordinary Markdown-chat instructions otherwise remain unchanged.

Before Pair verification, the companion verifies that the selected connector has
the expected schema through the upstream connector-verification path. Failure
stops before any private chat content is sent.

## 18. Companion protocol

### 18.1 Descriptor

The companion publishes a private descriptor under
`~/.codexify/browser/descriptor.json`:

```json
{
  "version": 1,
  "kind": "codexify-browser-companion",
  "pid": 1234,
  "endpoint": "http://127.0.0.1:43123",
  "token": "random-url-safe-secret",
  "build": "companion-version-and-protocol-hash",
  "createdAt": "RFC3339"
}
```

The file and parent directory use private permissions, reject symlinks, and are
atomically published. The bearer secret never appears in command-line arguments,
logs, owner-page HTML, model-visible output, or browser prompts.

### 18.2 RPC surface

All endpoints are loopback-only, bearer-authenticated, JSON, size-bounded, and
idempotent where mutation can lose its response.

```text
GET  /v1/health
POST /v1/session/login
POST /v1/session/capabilities
POST /v1/window/reveal
POST /v1/actions/execute
POST /v1/actions/cancel
GET  /v1/actions/{action_id}
GET  /v1/actions/{action_id}/events
```

`execute` accepts:

- unique action ID and idempotency key;
- exact paired URL and pairing generation;
- connector identity;
- model route and effort;
- one fixed prompt kind: `pair_verify`, `offline_chat`, `offline_goal`, or
  `offline_combined`;
- bounded prompt data;
- expected stable browser URL after navigation.

It does not accept JavaScript, CSS selectors, arbitrary browser commands, cookies,
or filesystem paths.

The event stream returns bounded operational events:

```text
queued
navigating
composer_ready
model_verified
connector_verified
send_accepted
status_delta
commentary_delta
answer_delta
generation_complete
approval_required
authentication_required
rate_limited
external_interference
ambiguous_send
failed
```

Normal responses never contain page HTML, cookies, screenshots, or unrelated
conversation content.

## 19. Persistent state

A representative task record is:

```json
{
  "version": 1,
  "taskKey": "stable-hash",
  "pairing": {
    "candidateUrl": null,
    "canonicalUrl": "https://chatgpt.com/...",
    "generation": 3,
    "verifiedOwnerGeneration": 7,
    "verifiedAt": "RFC3339"
  },
  "selection": {
    "model": "gpt-6-sol",
    "effort": "high",
    "catalogRevision": "opaque"
  },
  "goal": {
    "revision": 4,
    "markdown": "...",
    "status": "active",
    "createdAt": "RFC3339",
    "updatedAt": "RFC3339",
    "finishedAt": null,
    "summary": null,
    "blockedReason": null
  },
  "chatMirror": {
    "lastAcceptedBatchId": "opaque-id",
    "messageIds": ["opaque-id"],
    "transcriptRevisionAtStart": "opaque"
  },
  "action": {
    "id": "random-id",
    "kind": "offline_combined",
    "state": "idle",
    "lastError": null,
    "lastStableAnswer": null
  },
  "goalWake": {
    "activityEpoch": "process-epoch",
    "activitySequence": 47,
    "nudgedEpoch": "process-epoch",
    "nudgedSequence": 47,
    "lastNudgedAt": "RFC3339"
  }
}
```

Conversation URLs, chat text, goals, and browser output are private state and are
redacted from ordinary logs and audit previews. Pairing references and companion
bearer tokens are stored only as digests or in private credential files as
appropriate.

Records use the same safety properties as continuation and binding state:

- private directory and file permissions;
- bounded parse size;
- symlink and unsafe-type rejection;
- cross-process lock;
- temporary-file write, sync, and atomic publication;
- explicit schema version;
- fail-closed corruption handling.

The task record lives beside the stable task's private agent-chat state so normal
conversation continuation preserves it. Global companion installation,
descriptor, login partition, and account fingerprint live separately under
`~/.codexify/browser/`.

## 20. Configuration

Automation remains semantically inside `agentChat` and is opt-in:

```json
{
  "agentChat": {
    "enabled": true,
    "automation": {
      "enabled": false,
      "descriptorPath": "~/.codexify/browser/descriptor.json",
      "connectorName": "Codexify",
      "maxQueuedActions": 64,
      "autoApproveToolCalls": false
    }
  }
}
```

Constraints:

- automation requires `agentChat.enabled`;
- offline timing reuses the existing agent-chat presence threshold and is not
  independently configurable in the first version;
- one browser window is fixed behavior, not a configurable tab count;
- `maxQueuedActions` is bounded and protects global memory;
- `autoApproveToolCalls` defaults to false and, if later enabled, may click only a
  one-time approval, never persist a grant;
- connector names and descriptor paths are validated and bounded;
- no configuration field accepts arbitrary browser code or selectors.

Existing configurations remain valid. With automation absent or disabled, no
companion is required and startup behavior is unchanged.

## 21. Failure behavior

### Missing or unverified URL

Do not send. Preserve unread messages and active goals. Show the exact pairing
action required.

### Pairing mismatch

If `automation_verify_pairing` is called from a physical conversation that does
not resolve to the intended stable task, consume or expire the pairing attempt,
keep the URL unverified, and send no private task content.

### Browser or selector drift

Fail before Send. Preserve the pairing and pending work, mark the action failed,
and show a repair action. Never fall back to another selector, model, effort,
connector, or URL.

### Logged-out session

Pause browser actions. Open the visible sign-in surface only after the user
requests login. Do not import cookies from a normal browser.

### Deleted or inaccessible conversation

Mark the pairing unavailable and stop automatic sends. Ask the user to paste and
verify the current conversation URL. Do not create a replacement chat.

### Tool approval required

Set `approval_required` and expose it in standalone chat. Default policy does not
click approval automatically.

### Rate limit or unavailable effort

Surface the exact bounded state and stop. Do not downgrade effort, switch model,
or schedule retries.

### Ambiguous Send

If ChatGPT may have accepted a message but semantic evidence is incomplete, do
not resend. Preserve the action and batch IDs, reconcile from the exact paired
conversation, or require explicit user action.

### Browser stream disconnect

If Send was not accepted, the action may fail safely. If Send was accepted, do not
replay. Reconnect to the exact URL and reconcile the bound turn before another
queued action navigates the browser elsewhere.

### Wrong manually supplied URL after verification expires

No private content is sent until the URL is verified again for the current owner
generation.

### Codexify restart

Reload task records and queued intent. Do not automatically repeat a previously
accepted action. Resume only actions proven unsent; reconcile accepted actions
from the exact conversation.

### Companion restart

The single window may reopen at an idle surface. The Rust queue remains
canonical. The next action navigates to its exact paired URL after login and
protocol verification.

### Manual interference

Cancel or pause the current action, preserve unread chat and goal state, and
require explicit retry. Do not overwrite a user draft or navigate away from a
user-started generation.

### State corruption

Disable automation for the affected task and preserve the corrupt file for
manual recovery. Ordinary agent chat and connector tools continue to work.

## 22. Packaging and lifecycle

The companion should be a version-pinned optional Codexify artifact rather than a
global Bun dependency or Git submodule.

Recommended distribution:

- `browser-companion/` source directory in the Codexify repository;
- TypeScript/Bun source build for development;
- per-platform packaged Electron companion released alongside Codexify;
- a manifest binding companion protocol/build to the Codexify release;
- SHA-256 verification before install;
- private versioned installation under `~/.codexify/browser/runtime/`;
- explicit setup/update action;
- no download or process launch when automation is disabled.

The companion is a user-session process with one long-lived window. Codexify may
request start, reveal, login, or stop through an OS-appropriate launcher, but it
must verify the private descriptor and protocol before use.

**Open in ChatGPT** navigates the shared window to the task's paired URL only when
the current browser action is idle. While another response is running it reveals
that response and leaves the requested task queued rather than navigating away.

## 23. Proposed repository layout

```text
src/agent_automation/mod.rs       domain types and policy
src/agent_automation/store.rs     locked task-scoped persistence
src/agent_automation/supervisor.rs
                                  offline detection and global action queue
src/agent_automation/companion.rs authenticated companion protocol client
src/tools/goal.rs                 goal_read and goal_finish
src/tools/automation_pair.rs      one-time URL/task verification
src/owner_chat.rs                 owner APIs, URL pairing, goal commands
src/owner_chat.html               mapping/model/goal/stream UI
src/markdown_chat/mod.rs          reusable existing presence/activity feed

browser-companion/package.json
browser-companion/src/session.ts
browser-companion/src/model-selection.ts
browser-companion/src/connector-selection.ts
browser-companion/src/composer.ts
browser-companion/src/turn-binding.ts
browser-companion/src/response-stream.ts
browser-companion/src/browser-window.ts
browser-companion/src/control-server.ts
browser-companion/tests/

LICENSES/codex-chatgpt-web-MIT.txt
THIRD_PARTY_NOTICES.md
```

The companion cannot read Rust project state through filesystem shortcuts. Its
only Codexify-facing interface is the authenticated protocol.

## 24. Upstream-derived code boundary

### Import and adapt

- ChatGPT session and composer selectors;
- account capability inspection;
- model-family and effort discovery/verification;
- connector selection and cleanup;
- exact plaintext composer insertion;
- semantic Send acceptance observation;
- stable user/assistant turn binding;
- response Markdown conversion and stable incremental answer extraction;
- completion and generation-state observation;
- login, approval, rate-limit, terminal-error, and ambiguous-send detection;
- persistent Electron partition and private browser descriptor;
- focused browser fixtures and selector-drift tests.

### Adapt rather than import unchanged

- replace the upstream tab pool with one long-lived shared window;
- replace task-bound retained-tab leases with Rust-owned serialized actions;
- replace Responses/SSE output with a narrow browser-event stream to Codexify;
- replace Codex conversation keys with explicit user-paired URLs;
- retain only account/model/selector state in the companion.

### Do not import

- local Responses API server;
- Codex model catalog or provider routing;
- Codex configuration integration/journal;
- Codex prompt/context compiler;
- token-window and compaction transport;
- Codex subagent compatibility layers;
- MCP turn broker and tunnel-client integration;
- upstream multi-tab task retention;
- upstream launcher pages unrelated to login, capabilities, and browser health.

The extraction preserves upstream copyright headers where available and adds an
MIT license copy plus a third-party notice naming the source commit.

The browser code should remain structurally close to the upstream modules rather
than being rewritten into simplified local selectors. Vendored files record their
source paths and commit, and an update script produces a focused upstream diff so
new selector fixes, retry rules, and regression fixtures can be reviewed and
ported without rediscovering the same browser failures.

## 25. Testing strategy

### 25.1 Rust unit tests

- URL syntax validation and canonicalization boundaries;
- explicit URL requirement and absence of recency heuristics;
- pairing-reference issuance, expiry, replay rejection, digest-only storage, and
  stable-task comparison;
- owner-generation change invalidates pairing;
- ordinary online messages never call the companion;
- an offline unread message triggers automation without a goal;
- an offline active goal triggers automation without unread messages;
- combined unread-message and goal work produces one action;
- goal text is limited to 10 KiB;
- blocked goal completion requires a reason;
- no pause/resume state or commands exist;
- unread batches are mirrored but not acknowledged by the browser action itself;
- batching, coalescing, and idempotency IDs prevent duplicate prompts;
- one goal-only nudge per activity epoch;
- changing URL/model/effort/goal invalidates stale queued actions;
- helper failures never break ordinary agent chat;
- browser final output is persisted only when no `chat_write` output exists;
- accepted ambiguous actions are not replayed after restart;
- queue fairness prioritizes unread chat over goal-only work.

### 25.2 Companion unit and DOM tests

Port and reduce upstream fixtures for:

- login/session verification;
- live capability catalog;
- exact navigation to user-supplied URLs;
- ordinary and project conversation route shapes;
- model-family selection;
- effort selection and locked options;
- connector selection;
- composer ownership and exact insertion;
- send acceptance and ambiguous acceptance;
- stable turn binding;
- incremental stable answer streaming;
- approvals, rate limits, expired sessions, and selector drift;
- external mutation and unexpected navigation;
- one-window serialization and refusal to navigate while generating.

### 25.3 Protocol contract tests

Run Rust against a fake companion and the companion against protocol fixtures to
verify:

- version compatibility and rejection;
- bearer authentication;
- idempotent execute/cancel reconciliation;
- event-stream ordering and bounds;
- cancellation and timeout behavior;
- redaction and content-size limits;
- service/companion restart permutations;
- accepted-send reconciliation without replay.

### 25.4 Browser UI tests

Chromium and WebKit tests for standalone chat must prove:

- URL/model/effort/goal controls appear only when automation is enabled;
- the embedded ChatGPT widget contains no browser controls;
- ordinary online messages still use `chat_ui_send` only;
- an offline ordinary message can produce a browser action with no goal;
- `/goal` commands never appear in transcript history;
- only Run, Stop, Clear, and Status are exposed for goal lifecycle;
- goal-blocked state always renders its explanation;
- live browser output appears only for browser-driven offline actions;
- `chat_write` output suppresses duplicate final browser persistence;
- missing or expired pairing leaves chat messages pending;
- Open in ChatGPT reveals the one shared companion window;
- multiple offline tasks render queued order without implying multiple tabs;
- mobile and desktop layouts remain usable.

### 25.5 Live tests

Account-bound smoke tests remain opt-in and never run in ordinary CI. They cover:

1. login and capability discovery;
2. explicit URL pairing with a dedicated test conversation;
3. verification through `automation_verify_pairing`;
4. one offline ordinary-chat wake with no goal;
5. streamed assistant output;
6. one active-goal wake that either continues or calls `goal_finish`;
7. a second mapped task queued through the same window;
8. cleanup without deleting either ChatGPT conversation.

## 26. Implementation phases after approval

### Phase A — Single-window companion extraction

- vendor the narrow browser layer with MIT attribution;
- implement persistent login and capability discovery;
- implement exact URL navigation, model/effort selection, connector selection,
  Send acceptance, turn binding, and response streaming;
- implement the authenticated loopback protocol;
- prove one-window serialization in tests;
- no Codexify automation state yet.

### Phase B — Pairing and offline ordinary-chat fallback

- add `AgentAutomationStore` and the global supervisor queue;
- add standalone URL/model/effort controls;
- add one-time `automation_verify_pairing` without task transfer;
- connect existing offline presence to unread-message batching;
- stream browser output and implement transcript deduplication;
- no goals yet.

### Phase C — Goals

- add the 10 KiB goal store and simplified lifecycle;
- add `goal_read` and `goal_finish` with mandatory blocked reasons;
- add Run, Stop, Clear, and Status;
- combine goal evaluation with the next offline chat or goal-only wake;
- add one-nudge-per-activity-epoch policy.

### Phase D — Distribution and operational hardening

- build companion artifacts and checksum manifests;
- add setup, doctor, update, login, and reveal flows;
- complete security review, migration documentation, third-party notices, and
  opt-in live validation.

Each phase must leave existing manual connector usage and agent chat fully
functional when automation is disabled.

## 27. Revised review decisions

This revision makes the following concrete choices:

1. Browser automation is an offline fallback for ordinary agent chat, not only a
   goal runner.
2. While the task is online, the existing opportunistic tool-result delivery path
   is unchanged and the browser is untouched.
3. When offline, unread ordinary chat messages are copied into the paired ChatGPT
   prompt even if no goal exists.
4. Browser-visible assistant output is streamed into standalone Codexify chat only
   during browser-driven offline actions.
5. `chat_write` remains authoritative persisted output; stable browser final text
   is appended only when no tool-written agent message exists for that action.
6. The user must paste the exact ChatGPT conversation URL. Codexify uses no
   recency, project, or “latest conversation” heuristic.
7. A one-time pairing verification proves that the pasted URL's physical
   conversation already belongs to the intended stable task before private chat
   text is sent.
8. Pairing does not migrate the task, create a conversation, retire the manual
   conversation, or use `automation_attach`.
9. One long-lived browser window is shared by every task; Rust serializes and
   coalesces actions through a global queue.
10. Model and effort selection live only in standalone Codexify chat and never
    appear in Codex's model picker.
11. Goals are limited to 10 KiB, have no pause/resume state, and may be completed
    or blocked only through `goal_finish`; blocked requires an explanation.
12. Goal evaluation is included in the same offline wake-up that processes chat or
    continues work; no extra evaluation prompt is generated.
13. Automation remains opt-in under `agentChat.automation`.
14. Tool approvals, model fallback, retry after ambiguous Send, and rate-limit
    retries fail closed by default.
