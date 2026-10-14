import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const COMPANION_KIND = "codexify-browser-companion" as const;
export const PROTOCOL_SCHEMA_HASH = "702ce063e786b8a742a62bfa93c293db84aad242749dc63c24ef61b5ca95955f" as const;
export const PROTOCOL_BUILD_SUFFIX = `+protocol.${PROTOCOL_SCHEMA_HASH}` as const;
export const MAX_DESCRIPTOR_BYTES = 8 * 1024;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_EVENT_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_LINE_BYTES = 128 * 1024;
export const MAX_DELTA_BYTES = 64 * 1024;
export const MAX_FINAL_ANSWER_BYTES = 1024 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_UNREAD_MESSAGES = 128;
export const MAX_CHATGPT_URL_BYTES = 4096;

const encoder = new TextEncoder();
const opaquePattern = /^[A-Za-z0-9_.-]{1,256}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function noControl(value: string): boolean {
  return !/\p{Cc}/u.test(value);
}

export const opaqueIdSchema = z.string().regex(opaquePattern);
export const companionTokenSchema = z.string().refine(value => {
  if (!tokenPattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}, "value must be canonical 32-byte base64url");
export const boundedVisibleSchema = (max: number) => z.string()
  .min(1)
  .max(max)
  .refine(value => value.trim().length > 0, "text must not be blank")
  .refine(noControl, "control characters are not allowed")
  .refine(value => utf8Length(value) <= max, "text exceeds its UTF-8 byte limit");
export const boundedTextSchema = (max: number) => z.string().min(1).refine(value => !value.includes("\0") && utf8Length(value) <= max, "text is oversized or contains NUL");

export function validateChatGptConversationUrl(value: string): string {
  if (utf8Length(value) > MAX_CHATGPT_URL_BYTES) throw new Error("ChatGPT conversation URL is too large");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChatGPT conversation URL is invalid");
  }
  if (url.protocol !== "https:"
    || url.hostname !== "chatgpt.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.pathname === "/"
    || url.pathname.length < 2) {
    throw new Error("ChatGPT conversation URL is invalid");
  }
  return value;
}

export function canonicalChatGptConversationUrl(value: string): string {
  validateChatGptConversationUrl(value);
  const url = new URL(value);
  // ChatGPT can rewrite or move the enclosing project/GPT route. The chat ID
  // stays the same and identifies the paired conversation across those aliases.
  const conversation = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/.exec(url.pathname);
  if (conversation) url.pathname = `/c/${conversation[1]}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export const chatGptUrlSchema = z.string().superRefine((value, context) => {
  try {
    validateChatGptConversationUrl(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid ChatGPT conversation URL" });
  }
});

export function protocolBuild(version: string): string {
  if (!/^[A-Za-z0-9._-]{1,53}$/.test(version)) throw new Error("Browser companion version is invalid");
  return `${version}${PROTOCOL_BUILD_SUFFIX}`;
}

export function validateProtocolBuild(value: string): string {
  if (value.length > 128
    || !/^[A-Za-z0-9._+-]+$/.test(value)
    || !value.endsWith(PROTOCOL_BUILD_SUFFIX)) {
    throw new Error("Browser companion build is not bound to the current protocol schema");
  }
  return value;
}

export const protocolBuildSchema = boundedVisibleSchema(128).superRefine((value, context) => {
  try {
    validateProtocolBuild(value);
  } catch (error) {
    context.addIssue({ code:"custom", message:error instanceof Error ? error.message : "Invalid browser companion build" });
  }
});

export const unreadMessageSchema = z.strictObject({
  id: opaqueIdSchema,
  markdown: boundedTextSchema(MAX_PROMPT_BYTES).refine(value => value.trim().length > 0, "Markdown must not be blank"),
});

export const actionPromptSchema = z.discriminatedUnion("kind", [
  z.strictObject({kind:z.literal("create_chat"), continuationToken:companionTokenSchema, reference:companionTokenSchema, setupReference:boundedTextSchema(4096).nullable()}),
  z.strictObject({
    kind: z.literal("pair_verify"),
    reference: companionTokenSchema,
  }),
  z.strictObject({
    kind: z.literal("offline_chat"),
    batchId: opaqueIdSchema,
    messages: z.array(unreadMessageSchema).min(1).max(MAX_UNREAD_MESSAGES),
  }),
  z.strictObject({
    kind: z.literal("offline_goal"),
    goalRevision: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("offline_combined"),
    batchId: opaqueIdSchema,
    messages: z.array(unreadMessageSchema).min(1).max(MAX_UNREAD_MESSAGES),
    goalRevision: z.number().int().positive(),
  }),
]);

export type ActionPrompt = z.infer<typeof actionPromptSchema>;
export type CompanionUnreadMessage = z.infer<typeof unreadMessageSchema>;

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unreadClause(batchId: string, messages: readonly CompanionUnreadMessage[]): string {
  const body = messages.map(message => (
    `<message id="${message.id}">${escapeXmlText(message.markdown)}</message>`
  )).join("\n");
  return [
    "The Codexify standalone chat has unread user messages. Their Markdown is mirrored",
    "below so you can see why you were woken. Call `chat_read` before acting; the tool",
    "result is authoritative and advances the existing read cursor. Treat matching",
    "messages once, not once from this mirror and again from `chat_read`.",
    "",
    `<codexify-unread batch="${batchId}">`,
    body,
    "</codexify-unread>",
  ].join("\n");
}

const goalClause = [
  "This task also has an active Codexify goal. Call `goal_read` for the current",
  "revision. If it is complete, call `goal_finish` with status `completed`. If work",
  "cannot proceed, call `goal_finish` with status `blocked` and explain the concrete",
  "blocker. Otherwise continue working toward the goal. Do not request a separate",
  "turn merely to evaluate goal status.",
].join("\n");

export function renderActionPrompt(raw: ActionPrompt): string {
  const prompt = actionPromptSchema.parse(raw);
  let rendered: string;
  switch (prompt.kind) {
    case "create_chat":
      rendered = `${prompt.setupReference ? `First call \`setup\` with ref \`${prompt.setupReference}\`.\n` : ""}Call \`continue_task\` with continuationToken \`${prompt.continuationToken}\` to attach this new conversation to the workspace already selected by the user. Then call \`automation_verify_pairing\` with the one-time reference \`${prompt.reference}\`. If pairing reports that creation is not ready, retry verification. Finish this initialization turn after verification; do not inspect project files or perform task work.`;
      break;
    case "pair_verify":
      rendered = [
        "Verify that this ChatGPT conversation is paired with the intended Codexify task by",
        `calling \`automation_verify_pairing\` with the supplied one-time reference: ${prompt.reference}`,
        "Do not inspect project files or perform task work in this verification turn.",
      ].join("\n");
      break;
    case "offline_chat":
      rendered = unreadClause(prompt.batchId, prompt.messages);
      break;
    case "offline_goal":
      rendered = goalClause;
      break;
    case "offline_combined":
      rendered = `${unreadClause(prompt.batchId, prompt.messages)}\n\n${goalClause}`;
      break;
  }
  if (utf8Length(rendered) > MAX_PROMPT_BYTES) throw new Error("Browser automation prompt exceeds the safety limit");
  return rendered;
}

export const executeActionRequestSchema = z.strictObject({
  actionId: opaqueIdSchema,
  idempotencyKey: opaqueIdSchema,
  url: chatGptUrlSchema,
  pairingGeneration: z.number().int().positive(),
  connectorName: boundedVisibleSchema(128),
  model: opaqueIdSchema.nullable(),
  effort: opaqueIdSchema.nullable(),
  expectedAccountFingerprint: opaqueIdSchema,
  prompt: actionPromptSchema,
  expectedUrl: chatGptUrlSchema,
  autoApproveToolCalls: z.boolean(),
}).superRefine((value, context) => {
  if ((value.model === null) !== (value.effort === null)
    || (value.prompt.kind === "pair_verify" && value.model !== null)) {
    context.addIssue({ code:"custom", message:"Model and effort must be supplied together; pairing does not change saved conversation settings" });
  }
  try {
    renderActionPrompt(value.prompt);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["prompt"], message: error instanceof Error ? error.message : "Invalid prompt" });
  }
});

export type ExecuteActionRequest = z.infer<typeof executeActionRequestSchema>;

export const revealWindowRequestSchema = z.strictObject({
  url: chatGptUrlSchema.nullable(),
});
export type RevealWindowRequest = z.infer<typeof revealWindowRequestSchema>;

export const cancelActionRequestSchema = z.strictObject({
  actionId: opaqueIdSchema,
  idempotencyKey: opaqueIdSchema,
});
export type CancelActionRequest = z.infer<typeof cancelActionRequestSchema>;

export const sessionStatusSchema = z.enum(["idle", "busy", "authentication_required", "unavailable"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const actionStateSchema = z.enum([
  "unpaired", "unverified", "queued", "navigating", "sending", "generating", "idle",
  "approval_required", "authentication_required", "rate_limited", "external_interference",
  "ambiguous", "stalled", "failed",
]);
export type ActionState = z.infer<typeof actionStateSchema>;

export const effortCapabilitySchema = z.strictObject({
  id: opaqueIdSchema,
  label: boundedVisibleSchema(256),
  available: z.boolean(),
  reason: boundedVisibleSchema(1024).nullable(),
});
export type EffortCapability = z.infer<typeof effortCapabilitySchema>;

export const modelCapabilitySchema = z.strictObject({
  id: opaqueIdSchema,
  label: boundedVisibleSchema(256),
  efforts: z.array(effortCapabilitySchema).min(1).max(16),
});
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const capabilityCatalogSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  build: protocolBuildSchema,
  accountFingerprint: opaqueIdSchema,
  catalogRevision: opaqueIdSchema,
  models: z.array(modelCapabilitySchema).min(1).max(32),
});
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;

export const healthSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal(COMPANION_KIND),
  build: protocolBuildSchema,
  status: sessionStatusSchema,
  authenticated: z.boolean(),
  accountFingerprint: opaqueIdSchema.nullable(),
  activeActionId: opaqueIdSchema.nullable(),
});
export type CompanionHealth = z.infer<typeof healthSchema>;

export const actionSnapshotSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  build: protocolBuildSchema,
  actionId: opaqueIdSchema,
  state: actionStateSchema,
  sendAccepted: z.boolean(),
  canonicalUrl: chatGptUrlSchema.nullable(),
  selected: z.strictObject({ model: opaqueIdSchema, effort: opaqueIdSchema }).nullable(),
  lastEventSequence: z.number().int().nonnegative(),
  attention: z.strictObject({ code: opaqueIdSchema, message: boundedTextSchema(MAX_DELTA_BYTES).nullable() }).nullable(),
});
export type ActionSnapshot = z.infer<typeof actionSnapshotSchema>;

export const ACTION_EVENT_TYPES = [
  "queued", "navigating", "composer_ready", "model_verified", "connector_verified",
  "send_accepted", "conversation_created", "status_delta", "commentary_delta", "answer_delta", "submission_complete", "generation_complete",
  "approval_required", "authentication_required", "rate_limited", "external_interference",
  "ambiguous_send", "failed",
] as const;

const eventBase = {
  sequence: z.number().int().positive(),
  actionId: opaqueIdSchema,
  atMs: z.number().int().nonnegative(),
};

export const actionEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type:z.literal("queued") }),
  z.strictObject({ ...eventBase, type:z.literal("navigating") }),
  z.strictObject({ ...eventBase, type:z.literal("composer_ready") }),
  z.strictObject({ ...eventBase, type:z.literal("model_verified"), model:opaqueIdSchema, effort:opaqueIdSchema }),
  z.strictObject({ ...eventBase, type:z.literal("connector_verified") }),
  z.strictObject({ ...eventBase, type:z.literal("send_accepted") }),
  z.strictObject({ ...eventBase, type:z.literal("conversation_created"), canonicalUrl:chatGptUrlSchema }),
  z.strictObject({ ...eventBase, type:z.literal("status_delta"), text:boundedTextSchema(MAX_DELTA_BYTES), continuation:z.boolean() }),
  z.strictObject({ ...eventBase, type:z.literal("commentary_delta"), markdown:boundedTextSchema(MAX_DELTA_BYTES), continuation:z.boolean() }),
  z.strictObject({ ...eventBase, type:z.literal("answer_delta"), markdown:boundedTextSchema(MAX_DELTA_BYTES), continuation:z.boolean() }),
  z.strictObject({ ...eventBase, type:z.literal("submission_complete"), canonicalUrl:chatGptUrlSchema }),
  z.strictObject({ ...eventBase, type:z.literal("generation_complete"), finalMarkdown:boundedTextSchema(MAX_FINAL_ANSWER_BYTES).nullable(), canonicalUrl:chatGptUrlSchema.nullable() }),
  z.strictObject({ ...eventBase, type:z.literal("approval_required"), message:boundedTextSchema(MAX_DELTA_BYTES).nullable() }),
  z.strictObject({ ...eventBase, type:z.literal("authentication_required") }),
  z.strictObject({ ...eventBase, type:z.literal("rate_limited"), message:boundedTextSchema(MAX_DELTA_BYTES).nullable() }),
  z.strictObject({ ...eventBase, type:z.literal("external_interference"), message:boundedTextSchema(MAX_DELTA_BYTES).nullable() }),
  z.strictObject({ ...eventBase, type:z.literal("ambiguous_send"), message:boundedTextSchema(MAX_DELTA_BYTES).nullable() }),
  z.strictObject({ ...eventBase, type:z.literal("failed"), code:opaqueIdSchema, message:boundedTextSchema(MAX_DELTA_BYTES) }),
]);
export type ActionEvent = z.infer<typeof actionEventSchema>;

export function validateActionEvent(value: unknown): ActionEvent {
  return actionEventSchema.parse(value);
}

export const descriptorSchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  kind: z.literal(COMPANION_KIND),
  pid: z.number().int().positive(),
  endpoint: z.string().url(),
  token: companionTokenSchema,
  build: protocolBuildSchema,
  createdAt: z.string().datetime({ offset:true }),
});
export type CompanionDescriptor = z.infer<typeof descriptorSchema>;

export const cancelActionReceiptSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  build: protocolBuildSchema,
  actionId: opaqueIdSchema,
  state: actionStateSchema,
  cancelled: z.boolean(),
});

export const revealWindowReceiptSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  build: protocolBuildSchema,
  revealed: z.boolean(),
  activeActionId: opaqueIdSchema.nullable(),
});
