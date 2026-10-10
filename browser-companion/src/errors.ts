export type BrowserFailureCode =
  | "authentication_required"
  | "approval_required"
  | "rate_limited"
  | "external_interference"
  | "ambiguous_send"
  | "selector_drift"
  | "conversation_unavailable"
  | "model_unavailable"
  | "connector_unavailable"
  | "cancelled"
  | "failed";

export class BrowserCompanionError extends Error {
  readonly code: BrowserFailureCode;
  readonly sendAccepted: boolean;
  readonly cause?: unknown;

  constructor(message: string, code: BrowserFailureCode = "failed", options: { sendAccepted?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "BrowserCompanionError";
    this.code = code;
    this.sendAccepted = options.sendAccepted ?? false;
    this.cause = options.cause;
  }
}

export function selectorDrift(message: string, cause?: unknown): BrowserCompanionError {
  return new BrowserCompanionError(message, "selector_drift", { cause });
}

export function asCompanionError(error: unknown): BrowserCompanionError {
  if (error instanceof BrowserCompanionError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new BrowserCompanionError("Browser action was cancelled", "cancelled", { cause:error });
  }
  return new BrowserCompanionError("Browser companion operation failed", "failed", { cause:error });
}
