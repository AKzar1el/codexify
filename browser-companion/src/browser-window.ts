import { createHash } from "node:crypto";
import { asCompanionError, BrowserCompanionError } from "./errors";
import {
  COMPANION_KIND,
  MAX_DELTA_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_EVENT_STREAM_BYTES,
  PROTOCOL_VERSION,
  actionEventSchema,
  actionSnapshotSchema,
  cancelActionRequestSchema,
  executeActionRequestSchema,
  renderActionPrompt,
  type ActionEvent,
  type ActionPrompt,
  type ActionSnapshot,
  type ActionState,
  type CancelActionRequest,
  type CapabilityCatalog,
  type CompanionHealth,
  type ExecuteActionRequest,
  validateProtocolBuild,
} from "./protocol";

type WithoutEventEnvelope<T> = T extends ActionEvent
  ? Omit<T, "sequence" | "actionId" | "atMs">
  : never;
export type DriverEvent = WithoutEventEnvelope<ActionEvent>;

export const MAX_RETAINED_ACTIONS = 8;
const MAX_RETIRED_ACTIONS = 1024;
const MAX_RETAINED_CANCEL_KEYS = 1024;

export interface DriverExecution {
  request: ExecuteActionRequest;
  renderedPrompt: string;
  signal: AbortSignal;
  emit(event: DriverEvent): void;
}

export interface BrowserDriver {
  health(): Promise<{
    authenticated:boolean;
    accountFingerprint:string | null;
    status:"idle" | "busy" | "authentication_required" | "unavailable";
    detail:string | null;
  }>;
  login(): Promise<{
    authenticated:boolean;
    accountFingerprint:string | null;
    status:"idle" | "busy" | "authentication_required" | "unavailable";
    detail:string | null;
  }>;
  capabilities(): Promise<CapabilityCatalog>;
  reveal(url: string | null): Promise<void>;
  execute(execution: DriverExecution): Promise<void>;
  close?(): Promise<void>;
}

interface ActionRecord {
  request: ExecuteActionRequest;
  digest: string;
  snapshot: ActionSnapshot;
  events: ActionEvent[];
  eventBytes: number;
  connectorVerified: boolean;
  listeners: Set<(event: ActionEvent) => void>;
  abort: AbortController;
  terminal: boolean;
  runSettledPromise: Promise<void>;
  resolveRunSettled(): void;
}

interface RetiredActionRecord {
  digest: string;
  idempotencyKey: string;
  snapshot: ActionSnapshot;
}

function requestDigest(request: ExecuteActionRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function terminalType(type: ActionEvent["type"]): boolean {
  return [
    "generation_complete", "approval_required", "authentication_required", "rate_limited",
    "external_interference", "ambiguous_send", "failed",
  ].includes(type);
}

function cloneSnapshot(snapshot: ActionSnapshot): ActionSnapshot {
  return structuredClone(snapshot);
}

function stateForEvent(type: ActionEvent["type"], current: ActionState): ActionState {
  switch (type) {
    case "queued": return "queued";
    case "navigating": return "navigating";
    case "composer_ready": return "navigating";
    case "model_verified": return "navigating";
    case "connector_verified": return "navigating";
    case "send_accepted": return "sending";
    case "status_delta":
    case "commentary_delta":
    case "answer_delta": return "generating";
    case "generation_complete": return "idle";
    case "approval_required": return "approval_required";
    case "authentication_required": return "authentication_required";
    case "rate_limited": return "rate_limited";
    case "external_interference": return "external_interference";
    case "ambiguous_send": return "ambiguous";
    case "failed": return "failed";
    default: return current;
  }
}

function attentionFor(event: ActionEvent): ActionSnapshot["attention"] {
  switch (event.type) {
    case "approval_required": return { code:"approval_required", message:event.message };
    case "authentication_required": return { code:"authentication_required", message:null };
    case "rate_limited": return { code:"rate_limited", message:event.message };
    case "external_interference": return { code:"external_interference", message:event.message };
    case "ambiguous_send": return { code:"ambiguous_send", message:event.message };
    case "failed": return { code:event.code, message:event.message };
    default: return null;
  }
}

function boundedEventMessage(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, "�");
  if (!sanitized) return "Browser companion operation failed";
  const bytes = Buffer.from(sanitized, "utf8");
  const maximum = Math.min(MAX_DELTA_BYTES, Math.floor((MAX_EVENT_LINE_BYTES - 4096) / 2));
  if (bytes.length <= maximum) return sanitized;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") || "Browser companion operation failed";
}

const MAX_JSON_EXPANDING_CHUNK_BYTES = Math.floor((MAX_EVENT_LINE_BYTES - 4096) / 6);

function splitUtf8(value: string, maximumBytes: number): string[] {
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (characters.length > 0 && bytes + characterBytes > maximumBytes) {
      chunks.push(characters.join(""));
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += characterBytes;
  }
  if (characters.length > 0) chunks.push(characters.join(""));
  return chunks;
}

function splitTextDriverEvent(event: DriverEvent): DriverEvent[] | undefined {
  switch (event.type) {
    case "status_delta":
      return splitUtf8(event.text, MAX_JSON_EXPANDING_CHUNK_BYTES).map((text, index) => ({
        ...event,
        text,
        continuation:event.continuation || index > 0,
      }));
    case "commentary_delta":
      return splitUtf8(event.markdown, MAX_JSON_EXPANDING_CHUNK_BYTES).map((markdown, index) => ({
        ...event,
        markdown,
        continuation:event.continuation || index > 0,
      }));
    case "answer_delta":
      return splitUtf8(event.markdown, MAX_JSON_EXPANDING_CHUNK_BYTES).map((markdown, index) => ({
        ...event,
        markdown,
        continuation:event.continuation || index > 0,
      }));
    default:
      return undefined;
  }
}

export class SingleWindowCoordinator {
  private readonly actions = new Map<string, ActionRecord>();
  private readonly retiredActions = new Map<string, RetiredActionRecord>();
  private readonly executeKeys = new Map<string, string>();
  private readonly cancelKeys = new Map<string, { actionId:string; receipt:{
    protocolVersion:number; build:string; actionId:string; state:ActionState; cancelled:boolean;
  } }>();
  private activeActionId: string | null = null;
  private windowOperationTail: Promise<void> = Promise.resolve();

  constructor(private readonly driver: BrowserDriver, readonly build: string) {
    validateProtocolBuild(build);
  }

  async health(): Promise<CompanionHealth> {
    const health = await this.driver.health();
    return {
      protocolVersion:PROTOCOL_VERSION,
      kind:COMPANION_KIND,
      build:this.build,
      status:this.activeActionId ? "busy" : health.status,
      authenticated:health.authenticated,
      accountFingerprint:health.authenticated ? health.accountFingerprint : null,
      activeActionId:this.activeActionId,
    };
  }

  async login(): Promise<CompanionHealth> {
    return this.withWindowOperation(async () => {
      if (this.activeActionId) throw new Error(`Browser companion is busy with action ${this.activeActionId}`);
      const health = await this.driver.health();
      if (health.status === "busy") {
        throw new Error(health.detail || "Browser companion window is not idle");
      }
      await this.driver.login();
      return this.health();
    });
  }

  async capabilities(): Promise<CapabilityCatalog> {
    return this.withWindowOperation(async () => {
      if (this.activeActionId) throw new Error("Browser companion is busy with an active action");
      const health = await this.driver.health();
      if (health.status === "busy") {
        throw new Error(health.detail || "Browser companion window is not idle");
      }
      const catalog = await this.driver.capabilities();
      return { ...catalog, protocolVersion:PROTOCOL_VERSION, build:this.build };
    });
  }

  async reveal(url: string | null): Promise<{ protocolVersion:number; build:string; revealed:boolean; activeActionId:string | null }> {
    return this.withWindowOperation(async () => {
      let destination = this.activeActionId ? null : url;
      if (destination) {
        const health = await this.driver.health();
        if (health.status === "busy") destination = null;
      }
      await this.driver.reveal(destination);
      return {
        protocolVersion:PROTOCOL_VERSION,
        build:this.build,
        revealed:true,
        activeActionId:this.activeActionId,
      };
    });
  }

  async execute(raw: ExecuteActionRequest): Promise<ActionSnapshot> {
    const request = executeActionRequestSchema.parse(raw);
    const digest = requestDigest(request);
    return this.withWindowOperation(async () => {
      const keyedAction = this.executeKeys.get(request.idempotencyKey);
      if (keyedAction && keyedAction !== request.actionId) {
        throw new Error("Browser action idempotency key belongs to another action");
      }
      const existing = this.actions.get(request.actionId);
      if (existing) {
        if (existing.digest !== digest) throw new Error("Browser action ID belongs to a different request");
        return cloneSnapshot(existing.snapshot);
      }
      const retired = this.retiredActions.get(request.actionId);
      if (retired) {
        if (retired.digest !== digest) throw new Error("Browser action ID belongs to a different request");
        return cloneSnapshot(retired.snapshot);
      }
      if (this.activeActionId) throw new Error(`Browser companion is busy with action ${this.activeActionId}`);
      const health = await this.driver.health();
      if (!health.authenticated || health.status === "authentication_required") {
        throw new Error("Browser companion requires ChatGPT authentication");
      }
      if (health.status !== "idle") {
        throw new Error(health.detail || `Browser companion window is not idle (${health.status})`);
      }
      this.pruneActionHistory();

      let resolveRunSettled!: () => void;
      const runSettledPromise = new Promise<void>(resolve => { resolveRunSettled = resolve; });
      const record: ActionRecord = {
        request,
        digest,
        snapshot:{
          protocolVersion:PROTOCOL_VERSION,
          build:this.build,
          actionId:request.actionId,
          state:"queued",
          sendAccepted:false,
          canonicalUrl:null,
          selected:null,
          lastEventSequence:0,
          attention:null,
        },
        events:[],
        eventBytes:0,
        connectorVerified:false,
        listeners:new Set(),
        abort:new AbortController(),
        terminal:false,
        runSettledPromise,
        resolveRunSettled,
      };
      this.actions.set(request.actionId, record);
      this.executeKeys.set(request.idempotencyKey, request.actionId);
      this.activeActionId = request.actionId;
      this.emit(record, { type:"queued" });
      queueMicrotask(() => { void this.run(record); });
      return cloneSnapshot(record.snapshot);
    });
  }

  async action(actionId: string): Promise<ActionSnapshot | undefined> {
    const current = this.actions.get(actionId)?.snapshot ?? this.retiredActions.get(actionId)?.snapshot;
    return current ? cloneSnapshot(current) : undefined;
  }

  async cancel(raw: CancelActionRequest): Promise<{
    protocolVersion:number; build:string; actionId:string; state:ActionState; cancelled:boolean;
  }> {
    const request = cancelActionRequestSchema.parse(raw);
    const cached = this.cancelKeys.get(request.idempotencyKey);
    if (cached) {
      if (cached.actionId !== request.actionId) throw new Error("Cancel idempotency key belongs to another action");
      return structuredClone(cached.receipt);
    }
    const record = this.actions.get(request.actionId);
    const retired = this.retiredActions.get(request.actionId);
    if (!record && !retired) throw new Error("Browser action was not found");
    if (record) {
      record.abort.abort();
      await record.runSettledPromise;
    }
    const receipt = {
      protocolVersion:PROTOCOL_VERSION,
      build:this.build,
      actionId:request.actionId,
      state:(record?.snapshot ?? retired!.snapshot).state,
      cancelled:true,
    };
    if (this.cancelKeys.size >= MAX_RETAINED_CANCEL_KEYS) {
      const oldest = this.cancelKeys.keys().next().value;
      if (oldest) this.cancelKeys.delete(oldest);
    }
    this.cancelKeys.set(request.idempotencyKey, { actionId:request.actionId, receipt });
    return structuredClone(receipt);
  }

  async *events(actionId: string, afterSequence: number, signal?: AbortSignal): AsyncGenerator<ActionEvent> {
    const record = this.actions.get(actionId);
    if (!record && this.retiredActions.has(actionId)) {
      throw new Error("Browser action event history is no longer retained");
    }
    if (!record) throw new Error("Browser action was not found");
    let cursor = afterSequence;
    for (;;) {
      for (const event of record.events) {
        if (event.sequence <= cursor) continue;
        if (terminalType(event.type)) await record.runSettledPromise;
        cursor = event.sequence;
        yield structuredClone(event);
        if (terminalType(event.type)) return;
      }
      if (record.terminal) {
        await record.runSettledPromise;
        return;
      }
      if (signal?.aborted) throw new DOMException("Browser event stream aborted", "AbortError");
      const event = await new Promise<ActionEvent>((resolve, reject) => {
        const listener = (next: ActionEvent) => {
          cleanup();
          resolve(next);
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException("Browser event stream aborted", "AbortError"));
        };
        const cleanup = () => {
          record.listeners.delete(listener);
          signal?.removeEventListener("abort", onAbort);
        };
        record.listeners.add(listener);
        signal?.addEventListener("abort", onAbort, { once:true });
      });
      if (event.sequence <= cursor) continue;
      if (terminalType(event.type)) await record.runSettledPromise;
      cursor = event.sequence;
      yield structuredClone(event);
      if (terminalType(event.type)) return;
    }
  }

  async close(): Promise<void> {
    await this.withWindowOperation(async () => {
      for (const record of this.actions.values()) record.abort.abort();
      await Promise.all([...this.actions.values()].map(record => record.runSettledPromise));
      await this.driver.close?.();
    });
  }

  private async withWindowOperation<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.windowOperationTail;
    this.windowOperationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private pruneActionHistory(): void {
    while (this.actions.size >= MAX_RETAINED_ACTIONS) {
      const oldest = [...this.actions].find(([, record]) => record.terminal);
      if (!oldest) throw new Error("Browser action history is full while an action is still active");
      const [actionId, record] = oldest;
      this.actions.delete(actionId);
      this.retiredActions.set(actionId, {
        digest:record.digest,
        idempotencyKey:record.request.idempotencyKey,
        snapshot:{ ...cloneSnapshot(record.snapshot), lastEventSequence:0 },
      });
    }
    while (this.retiredActions.size > MAX_RETIRED_ACTIONS) {
      const oldest = this.retiredActions.entries().next().value as [string, RetiredActionRecord] | undefined;
      if (!oldest) break;
      const [actionId, record] = oldest;
      this.retiredActions.delete(actionId);
      if (this.executeKeys.get(record.idempotencyKey) === actionId) {
        this.executeKeys.delete(record.idempotencyKey);
      }
      for (const [key, cached] of this.cancelKeys) {
        if (cached.actionId === actionId) this.cancelKeys.delete(key);
      }
    }
  }

  private async run(record: ActionRecord): Promise<void> {
    try {
      await this.driver.execute({
        request:record.request,
        renderedPrompt:renderActionPrompt(record.request.prompt as ActionPrompt),
        signal:record.abort.signal,
        emit:event => this.emit(record, event),
      });
      if (!record.terminal) {
        this.emit(record, {
          type:"failed",
          code:"missing_terminal_event",
          message:"Browser driver ended without a terminal event",
        });
      }
    } catch (rawError) {
      if (record.terminal) return;
      const error = asCompanionError(rawError);
      if (record.snapshot.sendAccepted || error.sendAccepted) {
        this.emit(record, { type:"ambiguous_send", message:boundedEventMessage(error.message) });
      } else {
        this.emitFailure(record, error);
      }
    } finally {
      if (this.activeActionId === record.request.actionId) this.activeActionId = null;
      record.resolveRunSettled();
    }
  }

  private emitFailure(record: ActionRecord, error: BrowserCompanionError): void {
    const message = boundedEventMessage(error.message);
    switch (error.code) {
      case "authentication_required":
        this.emit(record, { type:"authentication_required" });
        break;
      case "approval_required":
        this.emit(record, { type:"approval_required", message });
        break;
      case "rate_limited":
        this.emit(record, { type:"rate_limited", message });
        break;
      case "external_interference":
        this.emit(record, { type:"external_interference", message });
        break;
      case "ambiguous_send":
        this.emit(record, { type:"ambiguous_send", message });
        break;
      default:
        this.emit(record, { type:"failed", code:error.code, message });
        break;
    }
  }

  private emit(record: ActionRecord, raw: DriverEvent): void {
    if (record.terminal) return;
    if (raw.type === "model_verified"
      && (raw.model !== record.request.model || raw.effort !== record.request.effort)) {
      throw new BrowserCompanionError(
        "Browser driver reported a different model or effort than requested",
        "failed",
      );
    }
    if (raw.type === "connector_verified" && !record.snapshot.selected) {
      throw new BrowserCompanionError(
        "Browser driver verified the connector before the requested model and effort",
        "failed",
      );
    }
    if (raw.type === "send_accepted"
      && (!record.snapshot.selected || !record.connectorVerified)) {
      throw new BrowserCompanionError(
        "Browser driver accepted Send before completing model and connector verification",
        "failed",
      );
    }
    if (["status_delta", "commentary_delta", "answer_delta", "generation_complete"].includes(raw.type)
      && !record.snapshot.sendAccepted) {
      throw new BrowserCompanionError(
        "Browser driver produced response output without semantic Send acceptance",
        "failed",
      );
    }
    if (raw.type === "generation_complete"
      && raw.canonicalUrl !== record.request.expectedUrl) {
      throw new BrowserCompanionError(
        "Browser driver completed in a different conversation than requested",
        "external_interference",
        { sendAccepted:true },
      );
    }
    const normalized: DriverEvent = raw.type === "failed" && record.snapshot.sendAccepted
      ? { type:"ambiguous_send", message:raw.message }
      : raw;
    let event = actionEventSchema.parse({
      ...normalized,
      sequence:record.snapshot.lastEventSequence + 1,
      actionId:record.request.actionId,
      atMs:Date.now(),
    });
    if (Buffer.byteLength(`${JSON.stringify(event)}\n`) > MAX_EVENT_LINE_BYTES) {
      const split = splitTextDriverEvent(normalized);
      if (split) {
        for (const part of split) this.emit(record, part);
        return;
      }
      if (event.type !== "generation_complete" || event.finalMarkdown === null) {
        throw new BrowserCompanionError(
          "Browser companion event exceeds the protocol line limit",
          "failed",
          { sendAccepted:record.snapshot.sendAccepted },
        );
      }
      event = actionEventSchema.parse({ ...event, finalMarkdown:null });
    }
    const lineBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`);
    const streamLimit = terminalType(event.type)
      ? MAX_EVENT_STREAM_BYTES
      : MAX_EVENT_STREAM_BYTES - MAX_EVENT_LINE_BYTES;
    if (record.eventBytes + lineBytes > streamLimit) {
      throw new BrowserCompanionError(
        "Browser companion event stream exceeds the protocol limit",
        "failed",
        { sendAccepted:record.snapshot.sendAccepted },
      );
    }
    record.events.push(event);
    record.eventBytes += lineBytes;
    record.snapshot.lastEventSequence = event.sequence;
    record.snapshot.state = stateForEvent(event.type, record.snapshot.state);
    record.snapshot.attention = attentionFor(event);
    if (event.type === "model_verified") record.snapshot.selected = { model:event.model, effort:event.effort };
    if (event.type === "connector_verified") record.connectorVerified = true;
    if (event.type === "send_accepted") {
      record.snapshot.sendAccepted = true;
      record.snapshot.canonicalUrl = record.request.expectedUrl;
    }
    if (event.type === "generation_complete") record.snapshot.canonicalUrl = event.canonicalUrl;
    actionSnapshotSchema.parse(record.snapshot);
    for (const listener of [...record.listeners]) listener(event);
    if (terminalType(event.type)) {
      record.terminal = true;
    }
  }
}
