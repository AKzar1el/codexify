import { createHash } from "node:crypto";
import { asCompanionError, BrowserCompanionError } from "./errors";
import {
  COMPANION_KIND,
  PROTOCOL_VERSION,
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
  listeners: Set<(event: ActionEvent) => void>;
  abort: AbortController;
  terminal: boolean;
  terminalPromise: Promise<void>;
  resolveTerminal(): void;
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

export class SingleWindowCoordinator {
  private readonly actions = new Map<string, ActionRecord>();
  private readonly executeKeys = new Map<string, string>();
  private readonly cancelKeys = new Map<string, { actionId:string; receipt:{
    protocolVersion:number; build:string; actionId:string; state:ActionState; cancelled:boolean;
  } }>();
  private activeActionId: string | null = null;

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
    await this.driver.login();
    return this.health();
  }

  async capabilities(): Promise<CapabilityCatalog> {
    if (this.activeActionId) throw new Error("Browser companion is busy with an active action");
    const catalog = await this.driver.capabilities();
    return { ...catalog, protocolVersion:PROTOCOL_VERSION, build:this.build };
  }

  async reveal(url: string | null): Promise<{ protocolVersion:number; build:string; revealed:boolean; activeActionId:string | null }> {
    await this.driver.reveal(this.activeActionId ? null : url);
    return {
      protocolVersion:PROTOCOL_VERSION,
      build:this.build,
      revealed:true,
      activeActionId:this.activeActionId,
    };
  }

  async execute(raw: ExecuteActionRequest): Promise<ActionSnapshot> {
    const request = executeActionRequestSchema.parse(raw);
    const digest = requestDigest(request);
    const keyedAction = this.executeKeys.get(request.idempotencyKey);
    if (keyedAction && keyedAction !== request.actionId) {
      throw new Error("Browser action idempotency key belongs to another action");
    }
    const existing = this.actions.get(request.actionId);
    if (existing) {
      if (existing.digest !== digest) throw new Error("Browser action ID belongs to a different request");
      return cloneSnapshot(existing.snapshot);
    }
    if (this.activeActionId) throw new Error(`Browser companion is busy with action ${this.activeActionId}`);
    const health = await this.driver.health();
    if (!health.authenticated || health.status === "authentication_required") {
      throw new Error("Browser companion requires ChatGPT authentication");
    }
    if (health.status !== "idle") {
      throw new Error(health.detail || `Browser companion window is not idle (${health.status})`);
    }

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>(resolve => { resolveTerminal = resolve; });
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
      listeners:new Set(),
      abort:new AbortController(),
      terminal:false,
      terminalPromise,
      resolveTerminal,
    };
    this.actions.set(request.actionId, record);
    this.executeKeys.set(request.idempotencyKey, request.actionId);
    this.activeActionId = request.actionId;
    this.emit(record, { type:"queued" });
    queueMicrotask(() => { void this.run(record); });
    return cloneSnapshot(record.snapshot);
  }

  async action(actionId: string): Promise<ActionSnapshot | undefined> {
    return this.actions.get(actionId) ? cloneSnapshot(this.actions.get(actionId)!.snapshot) : undefined;
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
    if (!record) throw new Error("Browser action was not found");
    if (!record.terminal) {
      record.abort.abort();
      await record.terminalPromise;
    }
    const receipt = {
      protocolVersion:PROTOCOL_VERSION,
      build:this.build,
      actionId:request.actionId,
      state:record.snapshot.state,
      cancelled:true,
    };
    this.cancelKeys.set(request.idempotencyKey, { actionId:request.actionId, receipt });
    return structuredClone(receipt);
  }

  async *events(actionId: string, afterSequence: number, signal?: AbortSignal): AsyncGenerator<ActionEvent> {
    const record = this.actions.get(actionId);
    if (!record) throw new Error("Browser action was not found");
    let cursor = afterSequence;
    for (;;) {
      for (const event of record.events) {
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield structuredClone(event);
        if (terminalType(event.type)) return;
      }
      if (record.terminal) return;
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
      cursor = event.sequence;
      yield structuredClone(event);
      if (terminalType(event.type)) return;
    }
  }

  async close(): Promise<void> {
    for (const record of this.actions.values()) if (!record.terminal) record.abort.abort();
    await Promise.all([...this.actions.values()].map(record => record.terminalPromise));
    await this.driver.close?.();
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
        this.emit(record, { type:"ambiguous_send", message:error.message });
      } else {
        this.emitFailure(record, error);
      }
    }
  }

  private emitFailure(record: ActionRecord, error: BrowserCompanionError): void {
    switch (error.code) {
      case "authentication_required":
        this.emit(record, { type:"authentication_required" });
        break;
      case "approval_required":
        this.emit(record, { type:"approval_required", message:error.message });
        break;
      case "rate_limited":
        this.emit(record, { type:"rate_limited", message:error.message });
        break;
      case "external_interference":
        this.emit(record, { type:"external_interference", message:error.message });
        break;
      case "ambiguous_send":
        this.emit(record, { type:"ambiguous_send", message:error.message });
        break;
      default:
        this.emit(record, { type:"failed", code:error.code, message:error.message });
        break;
    }
  }

  private emit(record: ActionRecord, raw: DriverEvent): void {
    if (record.terminal) return;
    const normalized: DriverEvent = raw.type === "failed" && record.snapshot.sendAccepted
      ? { type:"ambiguous_send", message:raw.message }
      : raw;
    const event = {
      ...normalized,
      sequence:record.snapshot.lastEventSequence + 1,
      actionId:record.request.actionId,
      atMs:Date.now(),
    } as ActionEvent;
    record.events.push(event);
    record.snapshot.lastEventSequence = event.sequence;
    record.snapshot.state = stateForEvent(event.type, record.snapshot.state);
    record.snapshot.attention = attentionFor(event);
    if (event.type === "model_verified") record.snapshot.selected = { model:event.model, effort:event.effort };
    if (event.type === "send_accepted") record.snapshot.sendAccepted = true;
    if (event.type === "generation_complete") record.snapshot.canonicalUrl = event.canonicalUrl;
    actionSnapshotSchema.parse(record.snapshot);
    for (const listener of [...record.listeners]) listener(event);
    if (terminalType(event.type)) {
      record.terminal = true;
      if (this.activeActionId === record.request.actionId) this.activeActionId = null;
      record.resolveTerminal();
    }
  }
}
