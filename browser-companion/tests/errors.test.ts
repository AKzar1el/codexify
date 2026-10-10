import { expect, test } from "bun:test";
import { asCompanionError, BrowserCompanionError } from "../src/errors";

test("unknown browser failures never expose raw page or request data", () => {
  const error = asCompanionError(new Error(
    "navigation failed at https://chatgpt.com/c/private-conversation with private browser prompt",
  ));

  expect(error.code).toBe("failed");
  expect(error.message).toBe("Browser companion operation failed");
  expect(error.message).not.toContain("private-conversation");
  expect(error.message).not.toContain("private browser prompt");
});

test("controlled companion failures preserve their bounded operational message", () => {
  const original = new BrowserCompanionError(
    "ChatGPT requires one-time approval in the shared browser window",
    "approval_required",
    { sendAccepted:true },
  );

  expect(asCompanionError(original)).toBe(original);
});
