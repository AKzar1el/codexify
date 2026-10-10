import { expect, test } from "bun:test";
import {
  newTurnIdentity,
  reboundTurnIdentity,
  submissionEvidence,
  turnIdentityFromAttributes,
} from "../src/turn-binding";

test("turn identity uses stable turn keys and never display indexes", () => {
  expect(turnIdentityFromAttributes({ role:"user", turnKey:"group-a", turnId:null })).toBe("group:user:group-a");
  expect(turnIdentityFromAttributes({ role:"assistant", turnKey:"group-a", turnId:null })).toBe("group:assistant:group-a");
  expect(turnIdentityFromAttributes({ role:"assistant", turnKey:null, turnId:"turn-123" })).toBe("turn-123");
  expect(() => turnIdentityFromAttributes({ role:"assistant", turnKey:null, turnId:null })).toThrow("stable identity");
});

test("one physical Send may create only one new logical turn", () => {
  expect(newTurnIdentity(["old"], ["old", "new"])).toBe("new");
  expect(newTurnIdentity(["old"], ["old"])).toBeUndefined();
  expect(() => newTurnIdentity(["old"], ["old", "new-a", "new-b"])).toThrow("2 new");
});

test("semantic submission evidence prefers the accepted user turn", () => {
  const baseline = ["group:user:old", "group:assistant:old"];
  expect(submissionEvidence({
    initialTurnIdentities:baseline,
    userIdentities:[...baseline, "group:user:new"],
    responseIdentities:["group:assistant:old"],
    generationRunning:true,
  })).toBe("user_turn");
  expect(submissionEvidence({
    initialTurnIdentities:baseline,
    userIdentities:["group:user:old"],
    responseIdentities:["group:assistant:old", "group:assistant:new"],
    generationRunning:true,
  })).toBe("assistant_turn");
  expect(submissionEvidence({
    initialTurnIdentities:baseline,
    userIdentities:["group:user:old"],
    responseIdentities:["group:assistant:old"],
    generationRunning:true,
  })).toBe("generation_running");
});

test("rebound assistant identity never chooses among competing turns", () => {
  const initial = ["group:assistant:old"];
  expect(reboundTurnIdentity(initial, "group:assistant:optimistic", ["group:assistant:optimistic"]))
    .toBe("group:assistant:optimistic");
  expect(reboundTurnIdentity(initial, "group:assistant:optimistic", ["group:assistant:old", "group:assistant:persisted"]))
    .toBe("group:assistant:persisted");
  expect(() => reboundTurnIdentity(initial, "group:assistant:optimistic", [
    "group:assistant:old", "group:assistant:persisted", "group:assistant:foreign",
  ])).toThrow("2 new");
});
