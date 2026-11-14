# Autonomous goal recovery: staged integration

This branch adapts focused concepts from LeZergan upstream Codexify PRs #22 and #24 with rollback-safe storage. It is not a wholesale merge of either PR.

## Opt-in persistent blocker audit

After installing a compatible binary, set agentChat.automation.persistentGoalBlockers to true. The default is false.

When enabled, goal_finish may mark a goal blocked only after the same reason persists across three distinct goal turns spanning at least 60 seconds. A rejection explains that constraint and requires continued lawful independent work. Real payment, invoicing, authorization and fulfillment gates remain intact. This grants no authorization to charge, spend, publish or accept contracts.

The audit lives in a private goal-blocker-audit.json sidecar; the existing strict AutomationTaskState JSON schema is unchanged for binary rollback compatibility. A new goal revision or a fresh explicit activation resets the audit identity.

Do not add the new setting to a live older Codexify configuration: older builds reject unknown keys. Enable only after a guarded compatible update.

## Stop recovery

The browser companion recognizes a stable Stop selector, a localized Stop button, and the explicit English End-turn control. A bounded native click waits for temporary disabled state. Existing real modal checks, account verification, message ownership and Send safeguards remain mandatory.

## Parallel browser lanes

The 4-page pool from PR #22 was inspected but deliberately NOT installed. This branch retains one browser action lane until measured tests establish safe isolation, HTTP 429 backoff, memory use and retries on the 16 GB Windows host.

## Verification and release

Check Rust formatting, Rust test targets, TypeScript, Stop-control unit tests, native Chrome Stop test, and full browser safety tests. Install only with a guarded quiet-fleet update, a known-good rollback, and a verification of real safe retry. This staging branch has not deployed any behavior by itself.
## Windows native test runner

Use Bun 1.4.0 (as specified in upstream CI) for the Patchright/Chrome native fixture tests. An isolated Windows probe showed that Bun 1.3.2 could launch Chrome but did not complete the Patchright connection; Node.js and Bun 1.4.0 completed the same launch quickly. The older runner therefore produces false test-startup failures. Do not weaken production browser timeouts to compensate.

The multi-scenario Windows fixtures allow additional aggregate test time while preserving original Linux CI budgets and Codexify's actual per-action deadlines. Verify the End-turn wait, localized Stop approval, non-modal popover exclusion, and rejection of unrelated approval dialogs as independent safety cases.

The Windows Codexify scheduled service requires elevated task-administration privileges for a guarded binary replacement. This branch is not installed merely by pushing commits; retain the original binary, companion and config as rollback inputs.