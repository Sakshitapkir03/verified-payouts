import { describe, expect, it } from "vitest";
import {
  buildEntry,
  canonicalJson,
  computeEntryHash,
  verifyChain,
  type AuditEntry,
  type AuditEntryInput,
} from "./chain";

const USER_ID = "3f0c6a52-6a0e-4e55-9a51-2f7d3c1b8e01";

function input(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    occurredAt: new Date("2026-11-05T12:00:00.000Z"),
    actorType: "user",
    actorId: USER_ID,
    action: "payout_item.held",
    entityType: "payout_item",
    entityId: "item-1",
    details: { reason: "first_payment_over_limit", amount_cents: 45000 },
    ...overrides,
  };
}

function chainOf(...inputs: AuditEntryInput[]): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const i of inputs) {
    entries.push(buildEntry(entries.at(-1)?.hash ?? null, i));
  }
  return entries;
}

function threeEntries(): AuditEntry[] {
  return chainOf(
    input({ action: "payee.invited", details: { n: 1 } }),
    input({ action: "payee.verified", details: { n: 2 } }),
    input({ action: "payout_item.approved", details: { n: 3 } }),
  );
}

describe("canonicalJson", () => {
  it("sorts object keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("computeEntryHash", () => {
  const data = buildEntry(null, input());

  it("is a 64-character hex SHA-256", () => {
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(computeEntryHash(null, data)).toBe(computeEntryHash(null, data));
  });

  it("does not depend on details key order", () => {
    const reordered = buildEntry(
      null,
      input({ details: { amount_cents: 45000, reason: "first_payment_over_limit" } }),
    );
    expect(reordered.hash).toBe(data.hash);
  });

  it("changes when the previous hash changes", () => {
    expect(computeEntryHash("a".repeat(64), data)).not.toBe(data.hash);
  });

  it.each<[string, Partial<AuditEntryInput>]>([
    ["occurredAt", { occurredAt: new Date("2026-11-05T12:00:00.001Z") }],
    ["actorType", { actorType: "payee" }],
    ["actorId", { actorId: "3f0c6a52-6a0e-4e55-9a51-2f7d3c1b8e02" }],
    ["action", { action: "payout_item.released" }],
    ["entityType", { entityType: "batch" }],
    ["entityId", { entityId: "item-2" }],
    ["details", { details: { reason: "first_payment_over_limit", amount_cents: 45001 } }],
  ])("changes when %s changes", (_field, overrides) => {
    expect(buildEntry(null, input(overrides)).hash).not.toBe(data.hash);
  });

  it("treats an uppercase actor id the same as lowercase", () => {
    const upper = buildEntry(null, input({ actorId: USER_ID.toUpperCase() }));
    expect(upper.actorId).toBe(USER_ID);
    expect(upper.hash).toBe(data.hash);
  });
});

describe("buildEntry validation", () => {
  it.each<[string, AuditEntryInput["details"]]>([
    ["a fractional number", { amount: 1.5 }],
    ["an unsafe integer", { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN", { amount: Number.NaN }],
    ["a string with NUL", { note: "a\u0000b" }],
    ["a lone surrogate", { note: "\ud800" }],
  ])("rejects details containing %s", (_label, details) => {
    expect(() => buildEntry(null, input({ details }))).toThrow();
  });

  it("rejects undefined values in details", () => {
    const details = { note: undefined } as unknown as AuditEntryInput["details"];
    expect(() => buildEntry(null, input({ details }))).toThrow();
  });

  it("requires an actor id for user actors", () => {
    expect(() => buildEntry(null, input({ actorId: null }))).toThrow();
  });

  it("requires a null actor id for system actors", () => {
    expect(() => buildEntry(null, input({ actorType: "system" }))).toThrow();
    expect(() =>
      buildEntry(null, input({ actorType: "system", actorId: null })),
    ).not.toThrow();
  });
});

describe("verifyChain", () => {
  it("accepts an empty log", () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it("accepts a valid chain", () => {
    expect(verifyChain(threeEntries())).toEqual({ ok: true });
  });

  it("links each entry to the previous entry's hash", () => {
    const [a, b, c] = threeEntries();
    expect(a.prevHash).toBeNull();
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
  });

  it("detects edited details", () => {
    const entries = threeEntries();
    entries[1] = { ...entries[1], details: { n: 99 } };
    expect(verifyChain(entries)).toEqual({
      ok: false,
      index: 1,
      reason: "hash_mismatch",
    });
  });

  it("detects an edited timestamp", () => {
    const entries = threeEntries();
    entries[2] = { ...entries[2], occurredAt: new Date("2020-01-01T00:00:00Z") };
    expect(verifyChain(entries)).toMatchObject({ ok: false, index: 2 });
  });

  it("detects an edit whose hash was recomputed, at the next entry", () => {
    const entries = threeEntries();
    const forged = buildEntry(entries[0].hash, input({ details: { n: 99 } }));
    entries[1] = forged;
    expect(verifyChain(entries)).toEqual({
      ok: false,
      index: 2,
      reason: "prev_hash_mismatch",
    });
  });

  it("detects a deleted entry", () => {
    const [a, , c] = threeEntries();
    expect(verifyChain([a, c])).toEqual({
      ok: false,
      index: 1,
      reason: "prev_hash_mismatch",
    });
  });

  it("detects reordered entries", () => {
    const [a, b, c] = threeEntries();
    expect(verifyChain([a, c, b])).toMatchObject({ ok: false, index: 1 });
  });

  it("detects a deleted first entry", () => {
    const [, b, c] = threeEntries();
    expect(verifyChain([b, c])).toEqual({
      ok: false,
      index: 0,
      reason: "prev_hash_mismatch",
    });
  });

  it("detects an inserted entry", () => {
    const [a, b, c] = threeEntries();
    const inserted = buildEntry(a.hash, input({ details: { n: 1.5e1 } }));
    expect(verifyChain([a, inserted, b, c])).toMatchObject({
      ok: false,
      index: 2,
    });
  });

  it("detects a replaced hash", () => {
    const entries = threeEntries();
    entries[2] = { ...entries[2], hash: "0".repeat(64) };
    expect(verifyChain(entries)).toEqual({
      ok: false,
      index: 2,
      reason: "hash_mismatch",
    });
  });

  it("verifies a segment from a known previous hash", () => {
    const [a, b, c] = threeEntries();
    expect(verifyChain([b, c], a.hash)).toEqual({ ok: true });
    expect(verifyChain([b, c], "f".repeat(64))).toMatchObject({ ok: false, index: 0 });
  });
});
