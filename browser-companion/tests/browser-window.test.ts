import { expect, test } from "bun:test";
import type { ActionEvent, CapabilityCatalog, ExecuteActionRequest } from "../src/protocol";
import {
  SingleWindowCoordinator,
  type BrowserDriver,
  type DriverExecution,
} from "../src/browser-window";
import { protocolBuild } from "../src/protocol";

const TEST_BUILD = protocolBuild("test-build");

const request = (id: string): ExecuteActionRequest => ({
  actionId:id,
  idempotencyKey:`idem-${id}`,
  url:`https://chatgpt.com/c/${id}`,
  pairingGeneration:1,
  connectorName:"Codexify",
  model:"gpt-6-sol",
  effort:"high",
  prompt:{ kind:"offline_chat", batchId:`batch-${id}`, messages:[{ id:`message-${id}`, markdown:"Continue." }] },
  expectedUrl:`https://chatgpt.com/c/${id}`,
  autoApproveToolCalls:false,
});

class DeferredDriver implements BrowserDriver {
  runs: string[] = [];
  releases = new Map<string, () => void>();
  authenticated = true;
  status: "idle" | "busy" | "authentication_required" | "unavailable" = "idle";

  async health() {
    return {
      authenticated:this.authenticated,
      accountFingerprint:this.authenticated ? "account-1" : null,
      status:this.status,
      detail:this.status === "idle" ? null : "The visible ChatGPT window is not idle",
    };
  }
  async login() { this.authenticated = true; return this.health(); }
  async capabilities(): Promise<CapabilityCatalog> {
    return {
      protocolVersion:1, build:TEST_BUILD, accountFingerprint:"account-1", catalogRevision:"catalog-1",
      models:[{ id:"gpt-6-sol", label:"GPT-6 Sol", efforts:[{ id:"high", label:"High", available:true, reason:null }] }],
    };
  }
  async reveal(_url: string | null) { return; }
  async execute(execution: DriverExecution): Promise<void> {
    this.runs.push(execution.request.actionId);
    execution.emit({ type:"navigating" });
    execution.emit({ type:"composer_ready" });
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({ type:"answer_delta", markdown:`answer-${execution.request.actionId}`, continuation:false });
    await new Promise<void>((resolve, reject) => {
      this.releases.set(execution.request.actionId, resolve);
      execution.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once:true });
    });
    execution.emit({ type:"generation_complete", finalMarkdown:`answer-${execution.request.actionId}`, canonicalUrl:execution.request.expectedUrl });
  }
}

async function collect(coordinator: SingleWindowCoordinator, actionId: string): Promise<ActionEvent[]> {
  const events: ActionEvent[] = [];
  for await (const event of coordinator.events(actionId, 0)) events.push(event);
  return events;
}

test("one companion window refuses a second task while a response is generating", async () => {
  const driver = new DeferredDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  const first = await coordinator.execute(request("first"));
  expect(first.state).toBe("queued");
  const eventsPromise = collect(coordinator, "first");
  await Bun.sleep(10);
  expect(driver.runs).toEqual(["first"]);
  await expect(coordinator.execute(request("second"))).rejects.toThrow("busy");
  expect(driver.runs).toEqual(["first"]);
  driver.releases.get("first")?.();
  const events = await eventsPromise;
  expect(events.map(event => event.type)).toEqual([
    "queued", "navigating", "composer_ready", "model_verified", "connector_verified",
    "send_accepted", "answer_delta", "generation_complete",
  ]);
  expect((await coordinator.action("first"))?.state).toBe("idle");
});

test("execute is idempotent but an action ID cannot be rebound to another request", async () => {
  const driver = new DeferredDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  const submitted = request("same");
  expect((await coordinator.execute(submitted)).actionId).toBe("same");
  expect((await coordinator.execute(structuredClone(submitted))).actionId).toBe("same");
  await expect(coordinator.execute({ ...submitted, effort:"medium" })).rejects.toThrow("different request");
  driver.releases.get("same")?.();
  await collect(coordinator, "same");
  expect(driver.runs).toEqual(["same"]);
});

test("cancellation is idempotent and never starts another action", async () => {
  const driver = new DeferredDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  await coordinator.execute(request("cancel"));
  await Bun.sleep(10);
  const first = await coordinator.cancel({ actionId:"cancel", idempotencyKey:"cancel-1" });
  expect(first.cancelled).toBeTrue();
  expect(first.state).toBe("ambiguous");
  const second = await coordinator.cancel({ actionId:"cancel", idempotencyKey:"cancel-1" });
  expect(second).toEqual(first);
  const events = await collect(coordinator, "cancel");
  expect(events.at(-1)?.type).toBe("ambiguous_send");
  expect(driver.runs).toEqual(["cancel"]);
});

test("a manually busy shared window is rejected before navigation or queue ownership", async () => {
  const driver = new DeferredDriver();
  driver.status = "busy";
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);

  await expect(coordinator.execute(request("manual-busy"))).rejects.toThrow("not idle");

  expect(driver.runs).toEqual([]);
  expect(await coordinator.action("manual-busy")).toBeUndefined();
  expect((await coordinator.health()).status).toBe("busy");
});
