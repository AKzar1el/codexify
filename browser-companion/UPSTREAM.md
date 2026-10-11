# Upstream browser harness

This directory contains a narrow adaptation of browser/session code from
`miuuyy/codex-chatgpt-web`, tag `v6.1.7`, commit
`f9ad4ae83a579287105ad822dd0c3e0029b04ef6`.

The adapted boundary includes ChatGPT session/composer selectors, model and effort
verification, connector selection, exact composer insertion, semantic Send
acceptance, turn binding, stable visible Markdown extraction, browser failure
classification, and the single-window browser session contract. The browser
surface now uses Patchright to launch its private Google Chrome for Testing with a dedicated
persistent profile, `channel: "chrome"`, `headless: false`, and `viewport: null`.
It does not override browser headers or the user agent. Background startup reuses
Patchright's launch arguments, replaces the initial `about:blank` launch with
`--no-startup-window`, and creates the page through CDP in a background window.
Only explicit sign-in/reveal actions restore and focus that window. The browser
window remains renderable because minimizing it can disrupt ChatGPT's model picker.
`executablePath` selects the bundled Chrome downloaded by Patchright rather than
system Chrome. Patchright 1.63 names this download target `chromium`, but its
managed executable is Google Chrome for Testing. Electron remains
the package launcher and does not create a browser window. Chrome uses
`chrome-profile` inside the configured browser home, separate from both the
legacy Electron profile and the user's normal Chrome profile. No profile data
is imported from either of them.

DOM evaluations use Patchright's default isolated context. They read browser DOM
APIs and maintain their own response observer registry; they do not depend on
ChatGPT's page-world JavaScript globals.

For local development, run `bun run install:chrome`, then the routed DOM fixture using
`CODEXIFY_TEST_BROWSER_COMPANION_CHROME=1 bun test ./tests/chrome-surface.test.ts`.
It uses a temporary profile and synthetic responses rather than a signed-in
ChatGPT session. CI runs this fixture under Xvfb.

It intentionally excludes the upstream Responses API server, Codex provider and
model catalog, prompt compiler, compaction transport, subagent protocol, tunnel
broker, and multi-tab retained-task architecture.

The upstream MIT license is copied to
`../LICENSES/codex-chatgpt-web-MIT.txt`. Derived source files identify their exact
upstream paths where applicable.
