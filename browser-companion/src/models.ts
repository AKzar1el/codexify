import { createHash } from "node:crypto";
import type { CapabilityCatalog, EffortCapability, ModelCapability } from "./protocol";

export type BrowserModelId = "gpt-5.6-luna" | "gpt-5.6-sol" | "gpt-6-sol";
export type BrowserEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type BrowserModelFamily = "5.6" | "6";

export interface AccountCapabilities {
  solAvailable: boolean;
  extraHighAvailable: boolean;
  proAvailable: boolean;
}

export interface ResolvedBrowserModel {
  id: BrowserModelId;
  family: BrowserModelFamily | null;
  effort: BrowserEffort;
  effortIndex: 0 | 1 | 2 | 3 | 4 | null;
  lunaThink: boolean;
}

const SOL_EFFORTS: readonly { id: BrowserEffort; label: string; index: 0 | 1 | 2 | 3 | 4 }[] = [
  { id:"low", label:"Instant", index:0 },
  { id:"medium", label:"Medium", index:1 },
  { id:"high", label:"High", index:2 },
  { id:"xhigh", label:"Extra High", index:3 },
  { id:"max", label:"Pro", index:4 },
];

function effortAvailability(
  effort: typeof SOL_EFFORTS[number],
  capabilities: AccountCapabilities,
): EffortCapability {
  const available = effort.id === "xhigh"
    ? capabilities.extraHighAvailable
    : effort.id === "max"
      ? capabilities.proAvailable
      : true;
  return {
    id:effort.id,
    label:effort.label,
    available,
    reason:available ? null : "not_available_for_account",
  };
}

function catalogRevision(accountFingerprint: string, models: readonly ModelCapability[]): string {
  const digest = createHash("sha256");
  digest.update("codexify-browser-catalog-v1\0");
  digest.update(accountFingerprint);
  digest.update("\0");
  digest.update(JSON.stringify(models));
  return digest.digest("hex");
}

export function buildCapabilityCatalog(
  capabilities: AccountCapabilities,
  accountFingerprint: string,
  build = "development",
): CapabilityCatalog {
  if (!/^[A-Za-z0-9_.-]{1,256}$/.test(accountFingerprint)) {
    throw new Error("ChatGPT account fingerprint is invalid");
  }
  const models: ModelCapability[] = capabilities.solAvailable
    ? ([
      { id:"gpt-5.6-sol", label:"GPT-5.6 Sol", efforts:SOL_EFFORTS.map(effort => effortAvailability(effort, capabilities)) },
      { id:"gpt-6-sol", label:"GPT-6 Sol", efforts:SOL_EFFORTS.map(effort => effortAvailability(effort, capabilities)) },
    ] satisfies ModelCapability[])
    : ([{
      id:"gpt-5.6-luna",
      label:"Luna",
      efforts:[
        { id:"low", label:"Luna", available:true, reason:null },
        { id:"medium", label:"Think", available:true, reason:null },
      ],
    }] satisfies ModelCapability[]);
  return {
    protocolVersion:1,
    build,
    accountFingerprint,
    catalogRevision:catalogRevision(accountFingerprint, models),
    models,
  };
}

export function resolveBrowserModel(
  model: string,
  effort: string,
  capabilities: AccountCapabilities,
): ResolvedBrowserModel {
  if (model === "gpt-5.6-luna") {
    if (capabilities.solAvailable) {
      throw new Error("ChatGPT Luna is unavailable while the account exposes the Sol selector");
    }
    if (effort !== "low" && effort !== "medium") {
      throw new Error(`ChatGPT Luna effort is not supported: ${effort}`);
    }
    return {
      id:model,
      family:null,
      effort,
      effortIndex:null,
      lunaThink:effort === "medium",
    };
  }
  if (model !== "gpt-5.6-sol" && model !== "gpt-6-sol") {
    throw new Error(`ChatGPT browser model is not supported: ${model}`);
  }
  if (!capabilities.solAvailable) {
    throw new Error("ChatGPT Sol models are unavailable for this Luna-only account");
  }
  const option = SOL_EFFORTS.find(candidate => candidate.id === effort);
  if (!option) throw new Error(`ChatGPT browser effort is not supported: ${effort}`);
  if (option.id === "xhigh" && !capabilities.extraHighAvailable) {
    throw new Error("ChatGPT Extra High effort is not available for this account");
  }
  if (option.id === "max" && !capabilities.proAvailable) {
    throw new Error("ChatGPT Pro effort is not available for this account");
  }
  return {
    id:model,
    family:model === "gpt-5.6-sol" ? "5.6" : "6",
    effort:option.id,
    effortIndex:option.index,
    lunaThink:false,
  };
}
