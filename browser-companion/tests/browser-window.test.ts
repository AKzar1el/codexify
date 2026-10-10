import { expect, test } from "bun:test";
import {
  MAX_DELTA_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_EVENT_STREAM_BYTES,
  type ActionEvent,
  type CapabilityCatalog,
  type ExecuteActionRequest,
} from "../src/protocol";
import {
  MAX_RETAINED_ACTIONS,
  SingleWindowCoordinator,
  type BrowserDriver,
  type DriverExecution,
} from "../src/browser-window";
import { protocolBuild } from "../src/protocol";
import { BrowserCompanionError } from "../src/errors";

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
  loginCalls = 0;
  capabilityCalls = 0;
  revealCalls: Array<string | null> = [];
  status: "idle" | "busy" | "authentication_required" | "unavailable" = "idle";

  async health() {
    return {
      authenticated:this.authenticated,
      accountFingerprint:this.authenticated ? "account-1" : null,
      status:this.status,
      detail:this.status === "idle" ? null : "The visible ChatGPT window is not idle",
    };
  }
  async login() { this.loginCalls += 1; this.authenticated = true; return this.health(); }
  async capabilities(): Promise<CapabilityCatalog> {
    this.capabilityCalls += 1;
    return {
      protocolVersion:1, build:TEST_BUILD, accountFingerprint:"account-1", catalogRevision:"catalog-1",
      models:[{ id:"gpt-6-sol", label:"GPT-6 Sol", efforts:[{ id:"high", label:"High", available:true, reason:null }] }],
    };
  }
  async reveal(url: string | null) { this.revealCalls.push(url); }
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

class SlowHealthDriver extends DeferredDriver {
  healthCalls = 0;
  activeHealthCalls = 0;
  maxActiveHealthCalls = 0;

  override async health() {
    this.healthCalls += 1;
    this.activeHealthCalls += 1;
    this.maxActiveHealthCalls = Math.max(this.maxActiveHealthCalls, this.activeHealthCalls);
    await Bun.sleep(25);
    this.activeHealthCalls -= 1;
    return super.health();
  }
}

class OversizedDeltaDriver extends DeferredDriver {
  override async execute(execution: DriverExecution): Promise<void> {
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({
      type:"answer_delta",
      markdown:"x".repeat(MAX_DELTA_BYTES + 1),
      continuation:false,
    });
    execution.emit({
      type:"generation_complete",
      finalMarkdown:"Done",
      canonicalUrl:execution.request.expectedUrl,
    });
  }
}

class LargeFinalDriver extends DeferredDriver {
  override async execute(execution: DriverExecution): Promise<void> {
    const chunks = ["a".repeat(60 * 1024), "b".repeat(60 * 1024), "c".repeat(60 * 1024)];
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    for (const [index, markdown] of chunks.entries()) {
      execution.emit({ type:"answer_delta", markdown, continuation:index > 0 });
    }
    execution.emit({
      type:"generation_complete",
      finalMarkdown:chunks.join(""),
      canonicalUrl:execution.request.expectedUrl,
    });
  }
}

class EventFloodDriver extends DeferredDriver {
  override async execute(execution: DriverExecution): Promise<void> {
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    for (let index = 0; index < 300; index += 1) {
      execution.emit({
        type:"status_delta",
        text:`${index.toString().padStart(3, "0")}${"x".repeat(MAX_DELTA_BYTES - 3)}`,
        continuation:false,
      });
    }
  }
}

class PrematureCompletionDriver extends DeferredDriver {
  override async execute(execution: DriverExecution): Promise<void> {
    execution.emit({
      type:"generation_complete",
      finalMarkdown:"Unaccepted output",
      canonicalUrl:execution.request.expectedUrl,
    });
  }
}

class LingeringTerminalDriver extends DeferredDriver {
  private resolveTerminalEmitted!: () => void;
  readonly terminalEmitted = new Promise<void>(resolve => { this.resolveTerminalEmitted = resolve; });
  private resolveReleaseAfterTerminal!: () => void;
  readonly releaseAfterTerminal = new Promise<void>(resolve => { this.resolveReleaseAfterTerminal = resolve; });

  release(): void {
    this.resolveReleaseAfterTerminal();
  }

  override async execute(execution: DriverExecution): Promise<void> {
    this.runs.push(execution.request.actionId);
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({
      type:"generation_complete",
      finalMarkdown:"Done",
      canonicalUrl:execution.request.expectedUrl,
    });
    this.resolveTerminalEmitted();
    await this.releaseAfterTerminal;
  }
}

class AbortableLingeringTerminalDriver extends DeferredDriver {
  private resolveTerminalEmitted!: () => void;
  private resolveRelease!: () => void;
  readonly terminalEmitted = new Promise<void>(resolve => { this.resolveTerminalEmitted = resolve; });
  readonly released = new Promise<void>(resolve => { this.resolveRelease = resolve; });
  aborted = false;

  release() {
    this.resolveRelease();
  }

  override async execute(execution: DriverExecution): Promise<void> {
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({
      type:"generation_complete",
      finalMarkdown:"done",
      canonicalUrl:execution.request.expectedUrl,
    });
    this.resolveTerminalEmitted();
    execution.signal.addEventListener("abort", () => {
      this.aborted = true;
      this.resolveRelease();
    }, { once:true });
    await this.released;
  }
}

class OversizedFailureDriver extends DeferredDriver {
  override async execute(): Promise<void> {
    throw new BrowserCompanionError("x".repeat(MAX_DELTA_BYTES + 1), "selector_drift");
  }
}

class NulFailureDriver extends DeferredDriver {
  override async execute(): Promise<void> {
    throw new BrowserCompanionError("selector\0failure", "selector_drift");
  }
}

class EmptyFailureDriver extends DeferredDriver {
  override async execute(): Promise<void> {
    throw new BrowserCompanionError("", "selector_drift");
  }
}

class JsonExpandingFailureDriver extends DeferredDriver {
  override async execute(): Promise<void> {
    throw new BrowserCompanionError("\\\u0001".repeat(MAX_DELTA_BYTES / 2), "selector_drift");
  }
}

class JsonExpandingAnswerDriver extends DeferredDriver {
  readonly markdown = "\\".repeat(MAX_DELTA_BYTES);

  override async execute(execution: DriverExecution): Promise<void> {
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({ type:"answer_delta", markdown:this.markdown, continuation:false });
    execution.emit({
      type:"generation_complete",
      finalMarkdown:this.markdown,
      canonicalUrl:execution.request.expectedUrl,
    });
  }
}

class ApprovalDriver extends DeferredDriver {
  override async execute(execution: DriverExecution): Promise<void> {
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({ type:"approval_required", message:"Approve once" });
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

test("concurrent execute preflights cannot acquire the single window twice", async () => {
  const driver = new SlowHealthDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  const results = await Promise.allSettled([
    coordinator.execute(request("concurrent-first")),
    coordinator.execute(request("concurrent-second")),
  ]);
  try {
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(driver.maxActiveHealthCalls).toBe(1);
    expect(driver.runs).toHaveLength(1);
  } finally {
    await coordinator.close();
  }
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

test("login cannot navigate the shared window away from an active action", async () => {
  const driver = new DeferredDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  await coordinator.execute(request("active-login"));
  await Bun.sleep(10);

  await expect(coordinator.login()).rejects.toThrow("busy");

  expect(driver.loginCalls).toBe(0);
  expect((await coordinator.health()).activeActionId).toBe("active-login");
  driver.releases.get("active-login")?.();
  await collect(coordinator, "active-login");
});

test("login cannot navigate away from a manually busy shared window", async () => {
  const driver = new DeferredDriver();
  driver.status = "busy";
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);

  await expect(coordinator.login()).rejects.toThrow("not idle");

  expect(driver.loginCalls).toBe(0);
});

test("reveal shows a manually busy shared window without navigating it", async () => {
  const driver = new DeferredDriver();
  driver.status = "busy";
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);

  await coordinator.reveal("https://chatgpt.com/c/requested");

  expect(driver.revealCalls).toEqual([null]);
});

test("capability refresh cannot mutate a manually busy shared window", async () => {
  const driver = new DeferredDriver();
  driver.status = "busy";
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);

  await expect(coordinator.capabilities()).rejects.toThrow("not idle");

  expect(driver.capabilityCalls).toBe(0);
});

test("invalid driver events fail closed before entering the action stream", async () => {
  const coordinator = new SingleWindowCoordinator(new OversizedDeltaDriver(), TEST_BUILD);
  await coordinator.execute(request("invalid-event"));

  const events = await collect(coordinator, "invalid-event");

  expect(events.some(event => event.type === "answer_delta")).toBeFalse();
  expect(events.at(-1)?.type).toBe("ambiguous_send");
});

test("large final answers stay within the event-line contract after streaming deltas", async () => {
  const coordinator = new SingleWindowCoordinator(new LargeFinalDriver(), TEST_BUILD);
  await coordinator.execute(request("large-final"));

  const events = await collect(coordinator, "large-final");
  const terminal = events.at(-1);

  expect(events.filter(event => event.type === "answer_delta")).toHaveLength(3);
  expect(terminal?.type).toBe("generation_complete");
  if (terminal?.type !== "generation_complete") throw new Error("missing terminal event");
  expect(terminal.finalMarkdown).toBeNull();
  expect(Buffer.byteLength(`${JSON.stringify(terminal)}\n`)).toBeLessThanOrEqual(MAX_EVENT_LINE_BYTES);
});

test("one action retains at most the bounded protocol event stream", async () => {
  const coordinator = new SingleWindowCoordinator(new EventFloodDriver(), TEST_BUILD);
  await coordinator.execute(request("event-budget"));

  const events = await collect(coordinator, "event-budget");
  const bytes = events.reduce(
    (total, event) => total + Buffer.byteLength(`${JSON.stringify(event)}\n`),
    0,
  );

  expect(bytes).toBeLessThanOrEqual(MAX_EVENT_STREAM_BYTES);
  expect(events.at(-1)?.type).toBe("ambiguous_send");
});

test("completed action history is bounded without replaying a retired action", async () => {
  const driver = new DeferredDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  for (let index = 0; index < MAX_RETAINED_ACTIONS + 2; index += 1) {
    const actionId = `history-${index}`;
    await coordinator.execute(request(actionId));
    while (!driver.releases.has(actionId)) await Bun.sleep(1);
    driver.releases.get(actionId)!();
    await collect(coordinator, actionId);
  }

  const retired = await coordinator.action("history-0");
  expect(retired?.state).toBe("idle");
  expect(retired?.lastEventSequence).toBe(0);
  const runs = driver.runs.length;
  expect(await coordinator.execute(request("history-0"))).toEqual(retired!);
  expect(driver.runs).toHaveLength(runs);
  await expect(collect(coordinator, "history-0")).rejects.toThrow("no longer retained");
  expect((await coordinator.action(`history-${MAX_RETAINED_ACTIONS + 1}`))?.lastEventSequence)
    .toBeGreaterThan(0);
});

test("a terminal answer without semantic Send acceptance fails closed", async () => {
  const coordinator = new SingleWindowCoordinator(new PrematureCompletionDriver(), TEST_BUILD);
  await coordinator.execute(request("premature-completion"));

  const events = await collect(coordinator, "premature-completion");

  expect(events.some(event => event.type === "generation_complete")).toBeFalse();
  expect(events.at(-1)?.type).toBe("failed");
  expect((await coordinator.action("premature-completion"))?.sendAccepted).toBeFalse();
});

test("the single window stays owned until the driver returns after its terminal event", async () => {
  const driver = new LingeringTerminalDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  await coordinator.execute(request("lingering-first"));
  const firstEvents = collect(coordinator, "lingering-first");
  await driver.terminalEmitted;

  await expect(coordinator.execute(request("lingering-second"))).rejects.toThrow("busy");
  expect(await Promise.race([
    firstEvents.then(() => "settled"),
    Bun.sleep(20).then(() => "waiting"),
  ])).toBe("waiting");

  driver.release();
  expect((await firstEvents).at(-1)?.type).toBe("generation_complete");
  while ((await coordinator.health()).activeActionId) await Bun.sleep(1);
  expect((await coordinator.execute(request("lingering-second"))).actionId).toBe("lingering-second");
  driver.releases.get("lingering-second")?.();
});

test("an event cursor at the terminal sequence waits for driver cleanup", async () => {
  const driver = new LingeringTerminalDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  const submitted = request("terminal-cursor");
  await coordinator.execute(submitted);
  await driver.terminalEmitted;
  const terminalSequence = (await coordinator.action(submitted.actionId))?.lastEventSequence;
  if (!terminalSequence) throw new Error("terminal sequence was not recorded");

  const resumed = (async () => {
    const events: ActionEvent[] = [];
    for await (const event of coordinator.events(submitted.actionId, terminalSequence)) {
      events.push(event);
    }
    return events;
  })();

  expect(await Promise.race([
    resumed.then(() => "settled"),
    Bun.sleep(20).then(() => "waiting"),
  ])).toBe("waiting");
  driver.release();
  expect(await resumed).toEqual([]);
});

test("shutdown aborts driver cleanup even after a terminal event", async () => {
  const driver = new AbortableLingeringTerminalDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  await coordinator.execute(request("terminal-cleanup-shutdown"));
  await driver.terminalEmitted;

  const closing = coordinator.close();
  const outcome = await Promise.race([
    closing.then(() => "closed"),
    Bun.sleep(20).then(() => "waiting"),
  ]);
  if (outcome === "waiting") driver.release();
  await closing;

  expect(outcome).toBe("closed");
  expect(driver.aborted).toBeTrue();
});

test("oversized driver failures become bounded terminal events instead of orphaned actions", async () => {
  const coordinator = new SingleWindowCoordinator(new OversizedFailureDriver(), TEST_BUILD);
  await coordinator.execute(request("oversized-failure"));
  await Bun.sleep(10);

  const snapshot = await coordinator.action("oversized-failure");
  expect(snapshot?.state).toBe("failed");
  const events = await collect(coordinator, "oversized-failure");
  const terminal = events.at(-1);
  expect(terminal?.type).toBe("failed");
  if (terminal?.type !== "failed") throw new Error("missing terminal failure");
  expect(Buffer.byteLength(terminal.message)).toBeLessThanOrEqual(MAX_DELTA_BYTES);
});

test("NUL-bearing driver failures become valid terminal events", async () => {
  const coordinator = new SingleWindowCoordinator(new NulFailureDriver(), TEST_BUILD);
  await coordinator.execute(request("nul-failure"));
  await Bun.sleep(10);

  const events = await collect(coordinator, "nul-failure");
  const terminal = events.at(-1);
  expect(terminal?.type).toBe("failed");
  if (terminal?.type !== "failed") throw new Error("missing terminal failure");
  expect(terminal.message).not.toContain("\0");
});

test("empty driver failures still produce a valid terminal event", async () => {
  const coordinator = new SingleWindowCoordinator(new EmptyFailureDriver(), TEST_BUILD);
  await coordinator.execute(request("empty-failure"));
  await Bun.sleep(10);

  const events = await collect(coordinator, "empty-failure");
  const terminal = events.at(-1);
  expect(terminal?.type).toBe("failed");
  if (terminal?.type !== "failed") throw new Error("missing terminal failure");
  expect(terminal.message).toBe("Browser companion operation failed");
});

test("JSON-expanding driver failures still fit one terminal event line", async () => {
  const coordinator = new SingleWindowCoordinator(new JsonExpandingFailureDriver(), TEST_BUILD);
  await coordinator.execute(request("json-expanding-failure"));
  await Bun.sleep(10);

  const snapshot = await coordinator.action("json-expanding-failure");
  expect(snapshot?.state).toBe("failed");
  const events = await collect(coordinator, "json-expanding-failure");
  const terminal = events.at(-1);
  expect(terminal?.type).toBe("failed");
  expect(Buffer.byteLength(`${JSON.stringify(terminal)}\n`)).toBeLessThanOrEqual(MAX_EVENT_LINE_BYTES);
});

test("JSON-expanding answer deltas are split without changing Markdown", async () => {
  const driver = new JsonExpandingAnswerDriver();
  const coordinator = new SingleWindowCoordinator(driver, TEST_BUILD);
  await coordinator.execute(request("json-expanding-answer"));

  const events = await collect(coordinator, "json-expanding-answer");
  const deltas = events.filter((event): event is Extract<ActionEvent, { type:"answer_delta" }> => (
    event.type === "answer_delta"
  ));

  expect(deltas.length).toBeGreaterThan(1);
  expect(deltas.map(event => event.markdown).join("")).toBe(driver.markdown);
  expect(deltas[0]?.continuation).toBeFalse();
  expect(deltas.slice(1).every(event => event.continuation)).toBeTrue();
  expect(events.at(-1)?.type).toBe("generation_complete");
  expect(events.every(event => (
    Buffer.byteLength(`${JSON.stringify(event)}\n`) <= MAX_EVENT_LINE_BYTES
  ))).toBeTrue();
});

test("post-Send attention snapshots retain the verified conversation URL", async () => {
  const coordinator = new SingleWindowCoordinator(new ApprovalDriver(), TEST_BUILD);
  const submitted = request("approval-after-send");
  await coordinator.execute(submitted);
  await collect(coordinator, submitted.actionId);

  const snapshot = await coordinator.action(submitted.actionId);
  expect(snapshot?.state).toBe("approval_required");
  expect(snapshot?.sendAccepted).toBeTrue();
  expect(snapshot?.canonicalUrl).toBe(submitted.expectedUrl);
});
