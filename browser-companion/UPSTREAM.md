# Upstream browser harness

This directory contains a narrow adaptation of browser/session code from
`miuuyy/codex-chatgpt-web`, tag `v6.1.7`, commit
`f9ad4ae83a579287105ad822dd0c3e0029b04ef6`.

The adapted boundary includes ChatGPT session/composer selectors, model and effort
verification, connector selection, exact composer insertion, semantic Send
acceptance, turn binding, stable visible Markdown extraction, browser failure
classification, and the persistent single-window Electron session.

It intentionally excludes the upstream Responses API server, Codex provider and
model catalog, prompt compiler, compaction transport, subagent protocol, tunnel
broker, and multi-tab retained-task architecture.

The upstream MIT license is copied to
`../LICENSES/codex-chatgpt-web-MIT.txt`. Derived source files identify their exact
upstream paths where applicable.
