import { chmod, lstat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { expect, test } from "bun:test";
import type { CapabilityCatalog } from "../src/protocol";
import { SingleWindowCoordinator, type BrowserDriver, type DriverExecution } from "../src/browser-window";
import { startControlServer } from "../src/control-server";

class ImmediateDriver implements BrowserDriver {
  async health() {
    return {
      authenticated:true,
      accountFingerprint:"account-test",
      status:"idle" as const,
      detail:null,
    };
  }
  async login() { return this.health(); }
  async capabilities(): Promise<CapabilityCatalog> {
    return {
      protocolVersion:1, build:"test-build", accountFingerprint:"account-test", catalogRevision:"catalog-test",
      models:[{ id:"gpt-6-sol", label:"GPT-6 Sol", efforts:[{ id:"high", label:"High", available:true, reason:null }] }],
    };
  }
  async reveal() {}
  async execute(execution: DriverExecution) {
    execution.emit({ type:"navigating" });
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({ type:"answer_delta", markdown:"Done", continuation:false });
    execution.emit({ type:"generation_complete", finalMarkdown:"Done", canonicalUrl:execution.request.expectedUrl });
  }
}

class BlockingDriver extends ImmediateDriver {
  override async execute(execution: DriverExecution) {
    execution.emit({ type:"send_accepted" });
    await new Promise<void>((_resolve, reject) => {
      execution.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once:true },
      );
    });
  }
}

function executeBody() {
  return {
    actionId:"control-action",
    idempotencyKey:"control-execute",
    url:"https://chatgpt.com/c/control",
    pairingGeneration:1,
    connectorName:"Codexify",
    model:"gpt-6-sol",
    effort:"high",
    prompt:{ kind:"offline_chat", batchId:"batch-control", messages:[{ id:"message-control", markdown:"Continue." }] },
    expectedUrl:"https://chatgpt.com/c/control",
    autoApproveToolCalls:false,
  };
}

test("private loopback server enforces bearer auth and streams bounded NDJSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexify-browser-control-"));
  const descriptorPath = join(root, "descriptor.json");
  const coordinator = new SingleWindowCoordinator(new ImmediateDriver(), "test-build");
  const server = await startControlServer(coordinator, descriptorPath);
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    expect(descriptor.endpoint).toBe(server.endpoint);
    expect(descriptor.token).toBe(server.token);
    expect(descriptor.kind).toBe("codexify-browser-companion");
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(descriptorPath)).mode & 0o777).toBe(0o600);
    }

    expect((await fetch(`${server.endpoint}/v1/health`)).status).toBe(401);
    const headers = { Authorization:`Bearer ${server.token}` };
    const health = await (await fetch(`${server.endpoint}/v1/health`, { headers })).json();
    expect(health).toMatchObject({ protocolVersion:1, kind:"codexify-browser-companion", authenticated:true });

    const executed = await (await fetch(`${server.endpoint}/v1/actions/execute`, {
      method:"POST", headers:{ ...headers, "Content-Type":"application/json" }, body:JSON.stringify(executeBody()),
    })).json();
    expect(executed.actionId).toBe("control-action");
    const stream = await fetch(`${server.endpoint}/v1/actions/control-action/events?after=0`, { headers });
    expect(stream.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await stream.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(lines.map(event => event.type)).toEqual([
      "queued", "navigating", "model_verified", "connector_verified", "send_accepted", "answer_delta", "generation_complete",
    ]);
    expect(lines.every((event, index) => event.sequence === index + 1)).toBeTrue();

    const status = await (await fetch(`${server.endpoint}/v1/actions/control-action`, { headers })).json();
    expect(status.state).toBe("idle");
    expect(JSON.stringify(status)).not.toContain(server.token);
  } finally {
    await server.close();
  }
  expect(await readFile(descriptorPath, "utf8").catch(() => null)).toBeNull();
});

test("request schemas are strict and descriptor symlinks fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexify-browser-control-"));
  const coordinator = new SingleWindowCoordinator(new ImmediateDriver(), "test-build");
  const server = await startControlServer(coordinator, join(root, "descriptor.json"));
  try {
    const headers = { Authorization:`Bearer ${server.token}`, "Content-Type":"application/json" };
    const bad = await fetch(`${server.endpoint}/v1/actions/execute`, {
      method:"POST", headers, body:JSON.stringify({ ...executeBody(), javascript:"document.cookie" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("document.cookie");
  } finally { await server.close(); }

  const target = join(root, "target.json");
  const linked = join(root, "linked.json");
  await Bun.write(target, "unchanged");
  await symlink(target, linked);
  await expect(startControlServer(coordinator, linked)).rejects.toThrow("symlink");
  expect(await readFile(target, "utf8")).toBe("unchanged");
  if (process.platform !== "win32") await chmod(root, 0o700);
});

test("shutdown aborts an active action before waiting for its NDJSON client", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexify-browser-control-"));
  const coordinator = new SingleWindowCoordinator(new BlockingDriver(), "test-build");
  const server = await startControlServer(coordinator, join(root, "descriptor.json"));
  const headers = { Authorization:`Bearer ${server.token}` };
  await fetch(`${server.endpoint}/v1/actions/execute`, {
    method:"POST",
    headers:{ ...headers, "Content-Type":"application/json" },
    body:JSON.stringify(executeBody()),
  });
  const stream = await fetch(`${server.endpoint}/v1/actions/control-action/events?after=0`, { headers });

  await expect(Promise.race([
    server.close().then(() => "closed"),
    Bun.sleep(1_000).then(() => "timeout"),
  ])).resolves.toBe("closed");

  const events = (await stream.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(events.at(-1)?.type).toBe("ambiguous_send");
});
