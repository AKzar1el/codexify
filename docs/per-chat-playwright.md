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

### Named persistent profiles and explicit handoff

On a compatible build, the managed per-chat source exposes one additional
function, `codexify_browser_session` (direct exposure:
`playwright__codexify_browser_session`, or the existing gateway/catalog).
It is only exposed when the upstream offers `browser_tabs`, and respects
the configured tool allow/deny list. The legacy default profile is unchanged.

| Action | Profile argument | Behavior |
| --- | --- | --- |
| list | none | Inspect saved profiles, selected profile, leases and last observed tabs; never launches, focuses, or expires a browser. |
| create | new private name | Provision and select a persistent directory; no Chrome process until a browser action. |
| launch | new private name | Create and select a new profile, then dispatch one blank-tab creation through normal scoped routing. |
| select / reconnect | existing name or default | Reuse an owned live MCP peer, or lazily start from the saved directory on the next browser action. |
| release | selected or explicit owned name | Relinquish an idle peer/lease; leave profile data on disk. Requires explicit reselection before dispatch. |

Names are lowercase ASCII letters, digits, hyphens and underscores, 1-40
characters. A private name is scoped to the durable task identity, source and
native service port; another task using the same name gets a different profile.
For reuse across unrelated conversations, the operator may explicitly allow
named shared profiles on a dedicated managed source. Example (merge only the
relevant keys into a compatible source configuration; preserve existing
command, pinned package, mode and other settings):

```json
{
  "sessionScope": "per-chat",
  "env": {
    "CODEXIFY_SHARED_PLAYWRIGHT_PROFILES": "authority-research,hackathons"
  }
}
```

Only configure names whose saved logins the operator explicitly authorizes
trusted tasks on that source to reuse. This is not an authentication or
authorization mechanism between independent human users of a shared service.
The source strips this internal setting from the child environment. Shared
names are reserved for that configuration; use select, not create, to prepare
and claim one. The browser data directory is separate from personal Chrome.
One task can hold a profile at a time. Busy claims and releases/switches during
an in-flight call fail closed. Release or an idle lease expiry allows another
task to explicitly claim the profile. After release or expiry of a shared
selection, the former owner must explicitly select again; no automatic
fallback or takeover. Chrome's own directory lock is still authoritative
if a previous browser process is shutting down; never force-kill it.

For a first login, select the allowed profile and use an ordinary browser
navigation or new-tab action on a headed managed source. The operator logs
in personally; the saved login remains in the directory. Later reconnect
to the same selected profile. A live peer retains its existing tab state;
after a peer is released or the service restarts, only persistent profile
data is guaranteed, not the exact set of open tabs. If a live peer failed,
release it when idle, then reconnect; never automatically replay a form.

The inventory is read-only and uses the last recognized tab list returned
by Playwright. It reports observation age, indices/current marker and
HTTP(S) origins for owned profiles (no page titles, URL paths, query strings
or credentials), and redacted counts/lease availability for other workers.
Unknown or unrecognized lists are explicitly unavailable. Use the existing
`browser_tabs {"action":"list"}` in an owned selected profile for a fresh
list. It does not enumerate personal Chrome windows or arbitrary CDP
endpoints, and does not query or focus another worker's browser. Extension
mode retains its existing per-task tab group behavior; named physical
profiles require managed browser mode.

No runtime config changes, new browser launches, or production service
restarts are required for source development or synthetic stdio tests.

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
