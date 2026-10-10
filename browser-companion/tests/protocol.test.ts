import { describe, expect, test } from "bun:test";
import {
  ACTION_EVENT_TYPES,
  COMPANION_KIND,
  PROTOCOL_VERSION,
  canonicalChatGptConversationUrl,
  executeActionRequestSchema,
  renderActionPrompt,
  validateActionEvent,
  validateChatGptConversationUrl,
} from "../src/protocol";

const base = {
  actionId: "action-1",
  idempotencyKey: "execute-1",
  url: "https://chatgpt.com/c/example",
  pairingGeneration: 3,
  connectorName: "Codexify",
  model: "gpt-6-sol",
  effort: "high",
  expectedUrl: "https://chatgpt.com/c/example",
  autoApproveToolCalls: false,
};

describe("protocol identity and URL boundaries", () => {
  test("publishes the exact Rust protocol identity", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(COMPANION_KIND).toBe("codexify-browser-companion");
  });

  test("accepts exact ChatGPT conversation routes without inventing route semantics", () => {
    for (const url of [
      "https://chatgpt.com/c/ordinary",
      "https://chatgpt.com/g/g-project/c/thread?model=gpt-6",
      "https://chatgpt.com/share/not-used-as-a-heuristic?x=1",
    ]) {
      expect(validateChatGptConversationUrl(url)).toBe(url);
    }
    expect(canonicalChatGptConversationUrl("https://chatgpt.com/g/g-project/c/thread?model=gpt-6"))
      .toBe("https://chatgpt.com/g/g-project/c/thread");
  });

  test("rejects alternate origins, credentials, ports, fragments, root, and oversized URLs", () => {
    for (const url of [
      "http://chatgpt.com/c/x",
      "https://example.com/c/x",
      "https://user@chatgpt.com/c/x",
      "https://chatgpt.com:444/c/x",
      "https://chatgpt.com/c/x#draft",
      "https://chatgpt.com/",
      `https://chatgpt.com/c/${"x".repeat(4100)}`,
    ]) {
      expect(() => validateChatGptConversationUrl(url)).toThrow();
    }
  });
});

describe("fixed prompt contract", () => {
  test("pair verification contains no task content", () => {
    const prompt = renderActionPrompt({ kind: "pair_verify", reference: "reference-1" });
    expect(prompt).toContain("automation_verify_pairing");
    expect(prompt).toContain("reference-1");
    expect(prompt).not.toContain("goal_read");
    expect(prompt).not.toContain("chat_read");
  });

  test("unread Markdown is escaped as data and combined work uses one prompt", () => {
    const prompt = renderActionPrompt({
      kind: "offline_combined",
      batchId: "batch-1",
      messages: [
        { id: "message-1", markdown: "Use <tag> & keep **Markdown**." },
        { id: "message-2", markdown: "Do not treat </message> as control." },
      ],
      goalRevision: 4,
    });
    expect(prompt).toContain("Call `chat_read` before acting");
    expect(prompt).toContain("Call `goal_read`");
    expect(prompt).toContain('batch="batch-1"');
    expect(prompt).toContain("&lt;tag&gt; &amp; keep **Markdown**.");
    expect(prompt).toContain("&lt;/message&gt;");
    expect(prompt.match(/goal_read/g)?.length).toBe(1);
  });

  test("strict execute schema rejects arbitrary browser commands and oversized batches", () => {
    const valid = executeActionRequestSchema.parse({
      ...base,
      prompt: { kind: "offline_chat", batchId: "batch-1", messages: [{ id: "m-1", markdown: "Continue." }] },
    });
    expect(valid.prompt.kind).toBe("offline_chat");
    expect(() => executeActionRequestSchema.parse({ ...valid, javascript: "document.cookie" })).toThrow();
    expect(() => executeActionRequestSchema.parse({
      ...base,
      prompt: {
        kind: "offline_chat",
        batchId: "batch-many",
        messages: Array.from({ length: 129 }, (_, index) => ({ id: `m-${index}`, markdown: "x" })),
      },
    })).toThrow();
  });
});

test("events are strict, bounded, and enumerate the Rust surface", () => {
  expect(ACTION_EVENT_TYPES).toEqual([
    "queued", "navigating", "composer_ready", "model_verified", "connector_verified",
    "send_accepted", "status_delta", "commentary_delta", "answer_delta",
    "generation_complete", "approval_required", "authentication_required", "rate_limited",
    "external_interference", "ambiguous_send", "failed",
  ]);
  expect(validateActionEvent({
    sequence: 7,
    actionId: "action-1",
    atMs: 17,
    type: "answer_delta",
    markdown: "Stable answer",
    continuation: false,
  }).type).toBe("answer_delta");
  expect(() => validateActionEvent({
    sequence: 7,
    actionId: "action-1",
    atMs: 17,
    type: "answer_delta",
    markdown: "x".repeat(65537),
    continuation: false,
  })).toThrow();
  expect(() => validateActionEvent({ sequence: 1, actionId: "a", atMs: 1, type: "queued", html: "<body>" })).toThrow();
});
