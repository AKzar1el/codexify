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
- The architecture document is currently untracked and will be committed with the implementation documentation.
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
