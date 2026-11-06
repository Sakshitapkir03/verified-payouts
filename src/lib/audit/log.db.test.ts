import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  sqlState,
  TEST_DATABASE_URL,
  useTestDatabase,
} from "../db/test-helpers";
import { buildEntry, type AuditEntryInput } from "./chain";
import { appendAuditEntry, verifyAuditLog } from "./log";

const ACTOR = "6b7e2c1a-4d3f-4b8e-9c2a-1f0e5d4c3b2a";

function input(n: number): AuditEntryInput {
  return {
    occurredAt: new Date(Date.UTC(2026, 10, 5, 12, 0, 0, n)),
    actorType: "user",
    actorId: ACTOR,
    action: "test.event",
    entityType: "test",
    entityId: `t-${n}`,
    details: { n, nested: { z: "Kōhaku", a: ["Роберт", true, null] } },
  };
}

async function tailHash(client: Client): Promise<string | null> {
  const { rows } = await client.query<{ hash: string }>(
    "SELECT hash FROM audit_entries ORDER BY id DESC LIMIT 1",
  );
  return rows[0]?.hash ?? null;
}

async function insertRaw(client: Client, prevHash: string | null, n: number) {
  const e = buildEntry(prevHash, input(n));
  return client.query(
    `INSERT INTO audit_entries
       (occurred_at, actor_type, actor_id, action, entity_type, entity_id, details, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.occurredAt, e.actorType, e.actorId, e.action, e.entityType, e.entityId,
      JSON.stringify(e.details), e.prevHash, e.hash],
  );
}

describe.skipIf(!TEST_DATABASE_URL)("audit_entries in Postgres", () => {
  const inRollback = useTestDatabase();

  it("appends linked entries that verify after a database round trip", () =>
    inRollback(async (client) => {
      const before = await tailHash(client);
      const a = await appendAuditEntry(client, input(1));
      const b = await appendAuditEntry(client, input(2));
      expect(a.prevHash).toBe(before);
      expect(b.prevHash).toBe(a.hash);
      expect(await verifyAuditLog(client)).toEqual({ ok: true });
    }));

  it("rejects UPDATE", () =>
    inRollback(async (client) => {
      await appendAuditEntry(client, input(1));
      expect(
        await sqlState(client.query("UPDATE audit_entries SET action = 'x'")),
      ).toBe("42501");
    }));

  it("rejects DELETE", () =>
    inRollback(async (client) => {
      await appendAuditEntry(client, input(1));
      expect(await sqlState(client.query("DELETE FROM audit_entries"))).toBe(
        "42501",
      );
    }));

  it("rejects TRUNCATE", () =>
    inRollback(async (client) => {
      expect(await sqlState(client.query("TRUNCATE audit_entries"))).toBe(
        "42501",
      );
    }));

  it("rejects an entry whose prev_hash is not the latest hash", () =>
    inRollback(async (client) => {
      await appendAuditEntry(client, input(1));
      expect(await sqlState(insertRaw(client, "a".repeat(64), 2))).toBe("23000");
    }));

  it("rejects a second entry following the same entry", () =>
    inRollback(async (client) => {
      const a = await appendAuditEntry(client, input(1));
      await appendAuditEntry(client, input(2));
      // Disable the tail check for this transaction only, to prove the unique
      // constraint stops a fork on its own.
      await client.query(
        "ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_link",
      );
      expect(await sqlState(insertRaw(client, a.prevHash, 3))).toBe("23505");
    }));

  it("refuses to append outside a transaction", async () => {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await expect(appendAuditEntry(client, input(1))).rejects.toThrow(
        /transaction block/,
      );
    } finally {
      await client.end();
    }
  });

  it("detects a tampered entry when verifying the log", () =>
    inRollback(async (client) => {
      await appendAuditEntry(client, input(1));
      await appendAuditEntry(client, input(2));
      // Simulate tampering by someone able to bypass the triggers.
      await client.query(
        "ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_no_update_delete",
      );
      await client.query(
        `UPDATE audit_entries SET details = '{"n": 99}'
         WHERE id = (SELECT max(id) FROM audit_entries)`,
      );
      expect(await verifyAuditLog(client)).toMatchObject({
        ok: false,
        reason: "hash_mismatch",
      });
    }));
});
