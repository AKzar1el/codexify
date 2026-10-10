import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  PROTOCOL_BUILD_SUFFIX,
  PROTOCOL_SCHEMA_HASH,
  actionEventSchema,
  actionSnapshotSchema,
  cancelActionReceiptSchema,
  cancelActionRequestSchema,
  capabilityCatalogSchema,
  descriptorSchema,
  executeActionRequestSchema,
  healthSchema,
  revealWindowReceiptSchema,
  revealWindowRequestSchema,
  validateProtocolBuild,
} from "../src/protocol";

const schemaBytes = await Bun.file(new URL("../protocol-schema-v1.json", import.meta.url)).arrayBuffer();
const protocolSchema = JSON.parse(Buffer.from(schemaBytes).toString("utf8"));
const fixture = await Bun.file(new URL("../protocol-fixtures/v1.json", import.meta.url)).json();

test("checked-in schema bytes, generated fixture, and runtime build suffix share one hash", () => {
  const hash = createHash("sha256").update(Buffer.from(schemaBytes)).digest("hex");
  expect(hash).toBe(PROTOCOL_SCHEMA_HASH);
  expect(fixture.schemaHash).toBe(PROTOCOL_SCHEMA_HASH);
  expect(PROTOCOL_BUILD_SUFFIX).toBe(`+protocol.${PROTOCOL_SCHEMA_HASH}`);
  expect(validateProtocolBuild(fixture.build)).toBe(fixture.build);
});

test("TypeScript parses every golden request, receipt, snapshot, and event strictly", () => {
  expect(descriptorSchema.parse(fixture.descriptor)).toEqual(fixture.descriptor);
  expect(healthSchema.parse(fixture.health)).toEqual(fixture.health);
  expect(capabilityCatalogSchema.parse(fixture.capabilities)).toEqual(fixture.capabilities);
  expect(revealWindowRequestSchema.parse(fixture.revealRequest)).toEqual(fixture.revealRequest);
  expect(revealWindowReceiptSchema.parse(fixture.revealReceipt)).toEqual(fixture.revealReceipt);
  expect(fixture.executeRequests.map((request: unknown) => executeActionRequestSchema.parse(request)))
    .toEqual(fixture.executeRequests);
  expect(actionSnapshotSchema.parse(fixture.actionSnapshot)).toEqual(fixture.actionSnapshot);
  expect(cancelActionRequestSchema.parse(fixture.cancelRequest)).toEqual(fixture.cancelRequest);
  expect(cancelActionReceiptSchema.parse(fixture.cancelReceipt)).toEqual(fixture.cancelReceipt);
  expect(fixture.events.map((event: unknown) => actionEventSchema.parse(event))).toEqual(fixture.events);
});

test("golden fixtures remain strict rather than becoming permissive compatibility aliases", () => {
  expect(() => executeActionRequestSchema.parse({
    ...fixture.executeRequests[3],
    prompt:{ ...fixture.executeRequests[3].prompt, goal_revision:3 },
  })).toThrow();
  expect(() => actionEventSchema.parse({ ...fixture.events[0], extra:"ignored" })).toThrow();
  expect(() => descriptorSchema.parse({ ...fixture.descriptor, build:"fixture" })).toThrow();
});

test("the hashed protocol manifest records the wire-level text bounds", () => {
  expect(protocolSchema.fieldLimits).toEqual({
    opaqueIdBytes:256,
    pairingReferenceBytes:43,
    connectorNameBytes:128,
    modelLabelBytes:256,
    effortLabelBytes:256,
    effortReasonBytes:1024,
    attentionMessageBytes:65536,
  });
});

test("pair verification requires one exact 32-byte base64url reference", () => {
  const request = fixture.executeRequests[0];
  const valid = "A".repeat(43);
  expect(executeActionRequestSchema.parse({
    ...request,
    prompt:{ kind:"pair_verify", reference:valid },
  }).prompt).toEqual({ kind:"pair_verify", reference:valid });
  expect(() => executeActionRequestSchema.parse(request)).toThrow();
  expect(() => executeActionRequestSchema.parse({
    ...request,
    prompt:{ kind:"pair_verify", reference:"A".repeat(42) },
  })).toThrow();
});

test("connector names use the configured 128-byte visible-text contract", () => {
  const request = fixture.executeRequests[3];
  expect(executeActionRequestSchema.parse({ ...request, connectorName:"x".repeat(128) }).connectorName)
    .toHaveLength(128);
  expect(() => executeActionRequestSchema.parse({ ...request, connectorName:"x".repeat(129) })).toThrow();
  expect(() => executeActionRequestSchema.parse({ ...request, connectorName:"   " })).toThrow();
});

test("unread Markdown is nonblank NUL-free data and respects rendered prompt bytes", () => {
  const request = fixture.executeRequests[1];
  expect(() => executeActionRequestSchema.parse({
    ...request,
    prompt:{ ...request.prompt, messages:[{ id:"fixture-message", markdown:"   " }] },
  })).toThrow();
  expect(() => executeActionRequestSchema.parse({
    ...request,
    prompt:{ ...request.prompt, messages:[{ id:"fixture-message", markdown:"x\0y" }] },
  })).toThrow();
  expect(() => executeActionRequestSchema.parse({
    ...request,
    prompt:{ ...request.prompt, messages:[{ id:"fixture-message", markdown:"&".repeat(60 * 1024) }] },
  })).toThrow();
});
