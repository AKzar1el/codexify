import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Cloudflare MCP example is opt-in, token-backed, and Code Mode", async () => {
  const config = JSON.parse(await readFile(
    new URL("../examples/mcp/cloudflare.code-mode.json", import.meta.url), "utf8"
  ));
  const server = config.mcpServers["cloudflare-api"];
  assert.equal(Object.keys(config.mcpServers).length, 1);
  assert.equal(server.disabled, true);
  assert.equal(server.type, "streamable-http");
  assert.equal(server.url, "https://mcp.cloudflare.com/mcp");
  assert.equal(server.mode, "direct");
  assert.equal(server.bearerTokenEnvVar, "CLOUDFLARE_API_TOKEN");
  assert.equal(server.url.includes("codemode=false"), false);
  assert.equal("bearerToken" in server, false);
  assert.equal("httpHeaders" in server, false);
  assert.ok(server.requestLimits.maxConcurrentRequests <= 2);
});
