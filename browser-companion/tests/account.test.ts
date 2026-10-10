import { expect, test } from "bun:test";
import { fingerprintAccountIdentity, validateAccountSessionProjection } from "../src/account";

test("account fingerprint is stable, private, and changes across user or account", () => {
  const first = fingerprintAccountIdentity("user-private", "account-private");
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).not.toContain("user-private");
  expect(first).toBe(fingerprintAccountIdentity("user-private", "account-private"));
  expect(first).not.toBe(fingerprintAccountIdentity("other-user", "account-private"));
  expect(first).not.toBe(fingerprintAccountIdentity("user-private", "other-account"));
});

test("session projection accepts only the bounded identity fields used by Codexify", () => {
  expect(validateAccountSessionProjection({
    userId:"user-1", accountId:"account-1", planType:"pro", structure:"personal", needsAttention:false,
  })).toEqual({
    userId:"user-1", accountId:"account-1", planType:"pro", structure:"personal", needsAttention:false,
  });
  for (const invalid of [
    { userId:"", accountId:"a", planType:"pro", structure:"personal", needsAttention:false },
    { userId:"u", accountId:"a", planType:"x".repeat(257), structure:"personal", needsAttention:false },
    { userId:"u", accountId:"a", planType:"pro", structure:"personal", needsAttention:"no" },
    { userId:"u", accountId:"a", planType:"pro", structure:"personal", email:"private@example.com", needsAttention:false },
  ]) expect(() => validateAccountSessionProjection(invalid)).toThrow();
});
