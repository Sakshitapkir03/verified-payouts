import "server-only";
import type { ClientBase } from "pg";
import {
  buildEntry,
  verifyChain,
  type AuditEntry,
  type AuditEntryInput,
  type ChainCheck,
  type JsonValue,
} from "./chain";

type AuditRow = {
  occurred_at: Date;
  actor_type: AuditEntry["actorType"];
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, JsonValue>;
  prev_hash: string | null;
  hash: string;
};

const COLUMNS =
  "occurred_at, actor_type, actor_id, action, entity_type, entity_id, details, prev_hash, hash";

function fromRow(row: AuditRow): AuditEntry {
  return {
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: row.details,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/**
 * Appends an entry to the audit chain. Must run inside the caller's
 * transaction, so the entry commits or rolls back with the change it records.
 */
export async function appendAuditEntry(
  client: ClientBase,
  input: AuditEntryInput,
): Promise<AuditEntry> {
  // Fails with "can only be used in transaction blocks" outside a transaction.
  await client.query("SAVEPOINT audit_append");
  try {
    // Same lock as the insert trigger: holds until the transaction ends, so
    // no other writer can append between reading the tail and inserting.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('audit_entries'))");
    const tail = await client.query<{ hash: string }>(
      "SELECT hash FROM audit_entries ORDER BY id DESC LIMIT 1",
    );
    const entry = buildEntry(tail.rows[0]?.hash ?? null, input);
    const { rows } = await client.query<AuditRow>(
      `INSERT INTO audit_entries (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        entry.occurredAt,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId,
        JSON.stringify(entry.details),
        entry.prevHash,
        entry.hash,
      ],
    );
    await client.query("RELEASE SAVEPOINT audit_append");
    return fromRow(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT audit_append");
    throw err;
  }
}

/** Reads the whole log in order and recomputes every hash. */
export async function verifyAuditLog(client: ClientBase): Promise<ChainCheck> {
  const { rows } = await client.query<AuditRow>(
    `SELECT ${COLUMNS} FROM audit_entries ORDER BY id`,
  );
  return verifyChain(rows.map(fromRow));
}
