# Per-chat Playwright MCP isolation (source-only prototype)

This implementation is opt-in and is NOT enabled by Codexify 2.3.29.
Do not enable new configuration fields until a compatible build is deployed.
Preserve custom automation settings including providerSendGatePath.

## Root cause

Previously Codexify opened one stdio upstream peer for each Playwright source at
server startup. Every ChatGPT task forwarded to the same upstream peer. Since
Playwright tracks a mutable current tab for each MCP connection, different
agents could interfere by selecting each other's tabs.

The opt-in sessionScope: per-chat now creates a distinct Playwright MCP peer
per durable ChatGPT task identity. Without trusted task or conversation
identity, all calls fail closed instead of falling back to the global peer.

## Managed-browser mode (stronger isolation)

Use a local Playwright MCP source without --extension and set sessionScope to
per-chat. Codexify creates a distinct, persistent user-data-dir for each task:
%USERPROFILE%\.codexify\playwright-agent-profiles\<server>\<native port>\<task hash>

The service port is part of the namespace so multiple Codexify instances
on one machine never contend for the same task browser profile.
This does not reuse the personal Chrome profile. Memory usage grows with
the number of concurrently active Chrome processes.

## Extension mode (tab-group isolation, weaker security)

Use the official Playwright Extension only on a dedicated, non-default
automation-only Chrome profile. The extension has broad access to the whole
profile; different tab groups are not strong sandbox boundaries.

It supports distinct MCP client session names/tab groups and can auto-authorize
using PLAYWRIGHT_MCP_EXTENSION_TOKEN. The token must never appear in Git, logs,
CI or messages. The optional enrollment script saves it as a user-only Windows
secret file, not in the live Codexify configuration.

Read-only dry run:
  powershell.exe -NoProfile -File scripts\enroll-playwright-extension-token.ps1

One-time enrollment (when ready to enable this feature):
  powershell.exe -NoProfile -File scripts\enroll-playwright-extension-token.ps1 -Apply -DedicatedProfile "Profile 3"

After deploying a compatible Codexify build, opt in ONLY the selected
mcpServers.playwright-extension entry with sessionScope: per-chat, and set
env.PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE to the absolute path printed by the
enrollment script. Preserve its existing extension args and profile settings.
Do not configure a second plaintext token at the same time.

A distinct named group is allocated per task and background mode requested.
Playwright Extension 0.5.0+ is needed for the background feature; Chromium
158+ is recommended when true background startup without focus is essential.
Older Chromium may still show/focus a connection page.

## Failure containment and capacity

- Never use global browser fallback after a per-chat routing failure
- Never connect extension mode without an explicit dedicated profile and token
- Reject unsupported shared-browser-context and existing CDP endpoint flags
- Direct, gateway and catalog bridge calls all carry trusted caller identity
- Keep no more than 16 per-source sessions and at most 3 concurrent starts;
  impose a 90-second cancellable startup deadline; release inactive sessions after
  one hour, never deleting browser profile directories
- This feature does not modify native Codexify browser companion profiles,
  production service, or saved browser Send receipts

## Deployment gates

1. Run Rust formatting, compile and focused isolation unit tests
2. Prove two synthetic task identities resolve to distinct MCP clients
3. Confirm that unknown identity fails before browser mutation
4. Exercise two disposable browser profiles on harmless local pages
5. Verify unchanged production config, including providerSendGatePath,
   against the final v2.4 candidate before any service cutover
6. Never silently retry or replay already-accepted browser Send actions
