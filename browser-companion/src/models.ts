import { createHash } from "node:crypto";
import { capabilityCatalogSchema, protocolBuild, type CapabilityCatalog, type EffortCapability, type ModelCapability } from "./protocol";

export type BrowserModelId = "gpt-5.6-luna" | "gpt-5.5-sol" | "gpt-5.6-sol" | "gpt-6-sol" | "gpt-6-astra";
export type BrowserEffort = string;
export type BrowserModelFamily = "5.5" | "5.6" | "6";

export const MODEL_FAMILY_LABELS: Record<BrowserModelFamily, RegExp> = {
  "5.5": /^GPT[-\s]?5\.5(?:\s+Sol)?(?:\s*Leaving on\s+.+)?$/i,
  "5.6": /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i,
  "6": /^(?:Latest|最新|최신|(?:GPT[-\s]?)?6(?:\s+(?:Sol|Astra))?(?:\s+Pro)?)$/i,
};

export function browserModelFamilyFromLabel(label: string): BrowserModelFamily | undefined {
  const normalized = label.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return (["6", "5.6", "5.5"] as const).find(family => MODEL_FAMILY_LABELS[family].test(normalized));
}

export interface AccountCapabilities {
  models: readonly DiscoveredBrowserModel[];
}

export interface DiscoveredBrowserEffort extends EffortCapability {
  index: number | null;
  lunaThink?: boolean;
}

export interface DiscoveredBrowserModel {
  id: BrowserModelId;
  label: string;
  family: BrowserModelFamily | null;
  efforts: readonly DiscoveredBrowserEffort[];
}

export interface ResolvedBrowserModel {
  id: BrowserModelId;
  family: BrowserModelFamily | null;
  effort: BrowserEffort;
  effortIndex: number | null;
  lunaThink: boolean;
}

/** Compatibility aliases preserve saved selections; they never create capabilities. */
export function browserEffortIdFromLabel(label: string): string {
  const normalized = label.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
  switch (normalized) {
    case "instant": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "extra high": return "xhigh";
    case "pro": return "max";
    default:
      if (!normalized) throw new Error("ChatGPT effort label is empty");
      return `effort-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
  }
}

export function modelsFromDiscoveredEfforts(
  family: BrowserModelFamily,
  efforts: readonly DiscoveredBrowserEffort[],
): DiscoveredBrowserModel[] {
  // ChatGPT's GPT-6 Pro option uses Astra. This is the explicit naming exception.
  if (family === "6") {
    return [
      { id:"gpt-6-astra", label:"GPT-6 Astra", family, efforts:efforts.filter(effort => /^Pro$/i.test(effort.label)) },
      { id:"gpt-6-sol", label:"GPT-6 Sol", family, efforts:efforts.filter(effort => !/^Pro$/i.test(effort.label)) },
    ].filter(model => model.efforts.length > 0) as DiscoveredBrowserModel[];
  }
  return [{ id:`gpt-${family}-sol`, label:`GPT-${family} Sol`, family, efforts }];
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
  build = protocolBuild("development"),
): CapabilityCatalog {
  if (!/^[A-Za-z0-9_.-]{1,256}$/.test(accountFingerprint)) {
    throw new Error("ChatGPT account fingerprint is invalid");
  }
  const models: ModelCapability[] = capabilities.models.map(model => ({
    id:model.id, label:model.label,
    efforts:model.efforts.map(({ id, label, available, reason }) => ({ id, label, available, reason })),
  }));
  return capabilityCatalogSchema.parse({
    protocolVersion:1,
    build,
    accountFingerprint,
    catalogRevision:catalogRevision(accountFingerprint, models),
    models,
  });
}

export function resolveBrowserModel(
  model: string,
  effort: string,
  capabilities: AccountCapabilities,
): ResolvedBrowserModel {
  const discovered = capabilities.models.find(candidate => candidate.id === model);
  if (!discovered) throw new Error(`ChatGPT model was not discovered for this account: ${model}`);
  const option = discovered.efforts.find(candidate => candidate.id === effort);
  if (!option) throw new Error(`ChatGPT effort was not discovered for ${discovered.label}: ${effort}`);
  if (!option.available) throw new Error(`ChatGPT ${option.label} effort is not available for this account`);
  return {
    id:discovered.id,
    family:discovered.family,
    effort:option.id,
    effortIndex:option.index,
    lunaThink:option.lunaThink === true,
  };
}
