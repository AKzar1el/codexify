# Optional MCP integrations (isolated pilot)

This pilot does not change the installed Codexify service, user configuration,
running browser sessions, or existing CI workflow. All changes are in a
separate Git branch/worktree. Do not enable them during an ongoing upgrade.

## 1. Official Cloudflare API MCP (opt-in)

Source: https://github.com/cloudflare/mcp

Codexify already supports remote Streamable HTTP MCP sources,
environment-backed bearer tokens, and direct tool exposure. No new Rust
transport or dependency is needed.

Copy only the cloudflare-api entry from
examples/mcp/cloudflare.code-mode.json into the existing mcpServers object
in your user Codexify config (typically ~/.codexify/codexify.config.json).
Do not replace the entire configuration with the example fragment.

Before changing disabled to false:

1. Create a Cloudflare API token restricted to the required account, zones,
   resources, and read-only permissions. Account tokens need Account
   Resources: Read for automatic account discovery.
2. Expose it as the CLOUDFLARE_API_TOKEN environment variable to the
   Codexify service process, not just a temporary terminal. Never put the
   token in JSON, command history, logs, or Git.
3. Validate the config with: codexify config validate (after the upgrade).
4. Set disabled to false and restart only during a planned maintenance
   window. Confirm the upstream startup report and one read-only call.

The endpoint is https://mcp.cloudflare.com/mcp without codemode=false,
preserving the compact Code Mode interface. The direct exposure mode
keeps Cloudflare's few original tool schemas and per-tool annotations
instead of adding another dispatcher.

CAUTION: Cloudflare's execute tool can mutate infrastructure. The
read-only API token is the actual authorization boundary.

The Codexify MCP bridge currently does not implement interactive remote OAuth
login. This opt-in example therefore uses an API bearer token.

## 2. Official MCP conformance smoke lane

Source: https://github.com/modelcontextprotocol/conformance

The independent workflow .github/workflows/mcp-conformance.yml runs when
this pilot branch is pushed and also supports manual dispatch once the
workflow exists on the repository's default branch. It builds Codexify
in an isolated GitHub Actions runner and uses pinned
@modelcontextprotocol/conformance@0.1.16. It does not alter existing
CI jobs or production services.

The launcher scripts/run-mcp-conformance.mjs creates an isolated temporary
configuration and workspace, chooses an ephemeral port, and disables user
MCP imports, agent chat, skills, and automatic worktree cleanup. It does
not load the installed Codexify configuration.

Smoke scenarios: server-initialize and tools-list.

These are not full MCP certification. OAuth, tool execution semantics,
and cross-version requirement sets are not yet covered.

To run on GitHub, push this branch to a repository you control. The
branch-limited push trigger runs both smoke scenarios. Manual dispatch
is available after the workflow file is present on the default branch.
Do not push to the upstream owner's repository by default.

For a specifically approved local run on a trusted machine, first build
the current checkout, then set CODEXIFY_CONFORMANCE_ALLOW_LOCAL=1 and
invoke node scripts/run-mcp-conformance.mjs. The test server has no MCP
bearer authentication, so do not run it on a shared or exposed host or
while the main Codexify upgrade is consuming resources.

## Optional third integration

Deferred. A GitHub Actions linter such as actionlint is a small follow-up
candidate, but it adds no immediate value to the Cloudflare connectivity
or protocol conformance experiment.
