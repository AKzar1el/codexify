import { createHash } from "node:crypto";
import type {Locator} from "patchright";
import {localizedEffortId,ambiguousEffortLabel,normalizeUiLabel,uiLabels,escapeUiPattern} from "./ui-localization";
import { capabilityCatalogSchema, protocolBuild, type CapabilityCatalog, type EffortCapability, type ModelCapability } from "./protocol";

export type BrowserModelId = "gpt-5.6-luna" | "gpt-5.5-sol" | "gpt-5.6-sol" | "gpt-6-sol" | "gpt-6-astra";
export type BrowserEffort = string;
export type BrowserModelFamily = "5.5" | "5.6" | "6";

export const MODEL_FAMILY_LABELS: Record<BrowserModelFamily, RegExp> = {
  "5.5": /^GPT[-\s]?5\.5(?:\s+(?:Sol|Luna))?$/iu,
  "5.6": /^GPT[-\s]?5\.6(?:\s+(?:Sol|Luna))?(?:\s+Pro)?$/iu,
  "6": new RegExp(`^(?:${uiLabels('latestModel').map(escapeUiPattern).join('|')}|(?:GPT[-\\s]?)?6(?:\\s+(?:Sol|Luna|Astra))?(?:\\s+Pro)?)$`,'iu'),
};

export function browserModelFamilyFromLabel(label: string): BrowserModelFamily | undefined {
  const normalized = normalizeUiLabel(label);
  return (["6", "5.6", "5.5"] as const).find(family => MODEL_FAMILY_LABELS[family].test(normalized));
}

/** Read identity and selection in one DOM revision; descriptions are not model names. */
export async function readModelOptionRows(menu:Locator):Promise<{family:BrowserModelFamily|undefined;label:string;checked:boolean}[]> {
  const patterns=Object.entries(MODEL_FAMILY_LABELS).map(([family,pattern])=>({family,source:pattern.source}));
  const values=await menu.getByRole("menuitemradio",{includeHidden:true}).evaluateAll((elements,patterns)=>elements.map(element=>{
    const clone=element.cloneNode(true) as Element;
    for(const description of clone.querySelectorAll('[data-menu-row-description],[data-model-retirement-notice],[data-testid="model-retirement-notice"],svg'))description.remove();
    const primary=clone.querySelector('[data-menu-row-label],[data-model-label]')??clone;
    let label=(primary.textContent??'').normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/\s+/g,' ').trim();
    const identity=element.getAttribute('data-model-id')??element.getAttribute('data-model-slug')??element.getAttribute('data-model-family')??element.getAttribute('data-family');
    const stable=/^(?:gpt-)?(5\.5|5\.6|6)(?:-(?:sol|astra|luna))?$/u.exec(identity??'')?.[1];
    const named=patterns.filter(pattern=>new RegExp(pattern.source,'iu').test(label)).map(pattern=>pattern.family);
    const family=stable?(!named.length||named.includes(stable)?stable:undefined):named.length===1?named[0]:undefined;
    if(stable&&family&&!named.length)label=`GPT-${family}`;
    if(family)element.setAttribute('data-browser-model-family',family);else element.removeAttribute('data-browser-model-family');
    return {family,label,checked:element.getAttribute('aria-checked')==='true'};
  }),patterns);
  return values.map(value=>({...value,family:value.family as BrowserModelFamily|undefined}));
}

export interface AccountCapabilities {
  models: readonly DiscoveredBrowserModel[];
}

export interface DiscoveredBrowserEffort extends EffortCapability {
  index: number | null;
  lunaThink?: boolean;
  observedModelName?: string;
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
  const normalized = normalizeUiLabel(label).toLowerCase();
  if(ambiguousEffortLabel(normalized))throw new Error("ChatGPT effort label has ambiguous locale translations");
  const known=localizedEffortId(normalized);
  if(known)return known;
  if (!normalized) throw new Error("ChatGPT effort label is empty");
  return `effort-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function modelsFromDiscoveredEfforts(
  family: BrowserModelFamily,
  efforts: readonly DiscoveredBrowserEffort[],
  pickerLabel?:string,
): DiscoveredBrowserModel[] {
  const observed=/\b(Sol|Luna|Astra)\b/i.exec(pickerLabel||"")?.[1];
  const label=(choices:readonly DiscoveredBrowserEffort[])=>{
    const name=choices.find(effort=>effort.observedModelName)?.observedModelName||observed;
    return `GPT-${family}${name?` ${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()}`:""}`;
  };
  // ChatGPT's GPT-6 Pro option uses Astra. This is the explicit naming exception.
  if (family === "6") {
    return [
      { id:"gpt-6-astra", label:"GPT-6 Astra", family, efforts:efforts.filter(effort => effort.id === "max") },
      { id:"gpt-6-sol", label:label(efforts.filter(effort => effort.id !== "max")), family, efforts:efforts.filter(effort => effort.id !== "max") },
    ].filter(model => model.efforts.length > 0) as DiscoveredBrowserModel[];
  }
  return [{ id:`gpt-${family}-sol`, label:label(efforts), family, efforts }];
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
  planKind: "free" | "go" | "pro" | "unknown" = "unknown",
): CapabilityCatalog {
  if (!/^[A-Za-z0-9_.-]{1,256}$/.test(accountFingerprint)) {
    throw new Error("ChatGPT account fingerprint is invalid");
  }
  const models: ModelCapability[] = capabilities.models.map(model => ({
    id:model.id, label:capabilityModelLabel(model, planKind),
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

/** Prefer picker names; only unnamed families need the verified account-plan fallback. */
export function capabilityModelLabel(model: DiscoveredBrowserModel, planKind: "free" | "go" | "pro" | "unknown"): string {
  if (model.id === "gpt-6-astra") return "GPT-6 Astra";
  if (/\b(?:Sol|Luna|Astra)\b/i.test(model.label)) return model.label;
  const suffix = planKind === "free" || planKind === "go" ? " Luna" : planKind === "pro" ? " Sol" : "";
  return model.label.replace(/^(GPT[-\s]?\d+(?:\.\d+)?)/i, "$1" + suffix);
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
