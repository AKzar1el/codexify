// Adapted from miuuyy/codex-chatgpt-web
// src/adapters/chatgpt-web/limits.ts at f9ad4ae83a579287105ad822dd0c3e0029b04ef6.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Page } from "playwright-core";

const sessionProjectionSchema = z.strictObject({
  userId:z.string().min(1).max(256),
  accountId:z.string().min(1).max(256),
  planType:z.string().min(1).max(256),
  structure:z.string().min(1).max(256),
  needsAttention:z.boolean(),
});

export type AccountSessionProjection = z.infer<typeof sessionProjectionSchema>;

export function validateAccountSessionProjection(value: unknown): AccountSessionProjection {
  return sessionProjectionSchema.parse(value);
}

export function fingerprintAccountIdentity(userId: string, accountId: string): string {
  const identity = sessionProjectionSchema.pick({ userId:true, accountId:true }).parse({ userId, accountId });
  return createHash("sha256")
    .update("codexify-browser-account-v1\0")
    .update(identity.userId)
    .update("\0")
    .update(identity.accountId)
    .digest("hex");
}

export async function readChatGptAccount(page: Page): Promise<{
  fingerprint:string;
  planType:string;
  personal:boolean;
  needsAttention:boolean;
}> {
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new Error("Open ChatGPT and sign in before inspecting account capabilities");
  }
  const projection = validateAccountSessionProjection(await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials:"same-origin",
      cache:"no-store",
      redirect:"error",
      signal:AbortSignal.timeout(5_000),
    });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      throw new Error("ChatGPT account session could not be verified");
    }
    const session = await response.json();
    if ((session?.error != null && session.error !== "")
      || (session?.expires != null && (
        typeof session.expires !== "string"
        || !Number.isFinite(Date.parse(session.expires))
        || Date.parse(session.expires) <= Date.now()
      ))) {
      throw new Error("ChatGPT session is expired");
    }
    return {
      userId:session?.user?.id,
      accountId:session?.account?.id,
      planType:session?.account?.planType,
      structure:session?.account?.structure,
      needsAttention:session?.account?.isDelinquent === true,
    };
  }));
  return {
    fingerprint:fingerprintAccountIdentity(projection.userId, projection.accountId),
    planType:projection.planType,
    personal:projection.structure === "personal",
    needsAttention:projection.needsAttention,
  };
}
