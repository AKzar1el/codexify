const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const jiti = require("jiti")(__filename);
const { SingleWindowCoordinator } = jiti("../src/browser-window.ts");
const { startControlServer } = jiti("../src/control-server.ts");
const { protocolBuild } = jiti("../src/protocol.ts");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, timeoutMs, description) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(description);
    await pause(10);
  }
}

test("native Node server aborts browser operation when a client TCP connection drops", { timeout: 12000 }, async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codexify-node-disconnect-"));
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  let cancelled = false;
  const driver = {
    async health() {
      return { authenticated: true, accountFingerprint: "account-test", status: "idle", detail: null };
    },
    async capabilities(signal) {
      await new Promise((_resolve, reject) => {
        const cancel = () => {
          cancelled = true;
          reject(new Error("request canceled"));
        };
        if (signal.aborted) return cancel();
        signal.addEventListener("abort", cancel, { once: true });
        entered();
      });
    },
    async reveal() {},
    async close() {},
  };
  const coordinator = new SingleWindowCoordinator(driver, protocolBuild("test-build"));
  const server = await startControlServer(coordinator, path.join(root, "descriptor.json"));
  let socket;
  try {
    const port = Number(new URL(server.endpoint).port);
    socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => {}); // expected ECONNRESET on destroy
    await once(socket, "connect");
    const request = [
      "POST /v1/session/capabilities HTTP/1.1",
      "Host: 127.0.0.1",
      "Authorization: Bearer " + server.token,
      "Content-Type: application/json",
      "Content-Length: 2",
      "",
      "{}",
    ].join("\r\n");
    socket.write(request);
    await Promise.race([
      reached,
      pause(3000).then(() => { throw new Error("Capabilities handler was not entered"); }),
    ]);
    socket.destroy();
    await until(() => cancelled, 3000, "Request cancellation did not reach browser driver");
    const response = await fetch(server.endpoint + "/v1/window/reveal", {
      method: "POST",
      headers: { Authorization: "Bearer " + server.token, "Content-Type": "application/json" },
      body: JSON.stringify({ url: null }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revealed, true);
    console.log("NATIVE_NODE_CANCEL=PASS");
  } finally {
    socket?.destroy();
    await server.close();
    fs.rmSync(root, { recursive: true });
  }
});
