import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { sqlState, TEST_DATABASE_URL, useTestDatabase } from "./test-helpers";

async function fixtures(client: Client) {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, role)
     VALUES ('schema-test@example.com', 'Schema Test', 'operator') RETURNING id`,
  );
  const userId = user.rows[0].id;
  const payee = await client.query<{ id: string }>(
    `INSERT INTO payees (display_name, contact_email, invited_by)
     VALUES ('Test Payee', 'payee@example.com', $1) RETURNING id`,
    [userId],
  );
  const batch = await client.query<{ id: string }>(
    `INSERT INTO batches (sender_batch_id, uploaded_by)
     VALUES ('schema-test-batch', $1) RETURNING id`,
    [userId],
  );
  return { userId, payeeId: payee.rows[0].id, batchId: batch.rows[0].id };
}

async function insertItem(
  client: Client,
  f: { batchId: string; payeeId: string },
  values: { amount?: unknown; currency?: string; state?: string; holds?: string } = {},
) {
  if (values.state || values.holds) {
    // These tests check CHECK constraints directly, so bypass the state
    // machine guard for this transaction only.
    await client.query("SELECT set_config('verified_payouts.state_machine', 'on', true)");
  }
  return client.query(
    `INSERT INTO payout_items
       (batch_id, line_number, payee_id, amount_cents, currency, state, hold_reasons, sender_item_id)
     VALUES ($1, 1, $2, $3, $4, $5, $6, 'schema-test-item')`,
    [
      f.batchId,
      f.payeeId,
      values.amount ?? 1000,
      values.currency ?? "USD",
      values.state ?? "draft",
      values.holds ?? "[]",
    ],
  );
}

const CHECK_VIOLATION = "23514";

describe.skipIf(!TEST_DATABASE_URL)("schema rules", () => {
  const inRollback = useTestDatabase();

  it("accepts a valid draft item in integer cents", () =>
    inRollback(async (client) => {
      await expect(insertItem(client, await fixtures(client))).resolves.toBeDefined();
    }));

  it("rejects zero and negative amounts", () =>
    inRollback(async (client) => {
      const f = await fixtures(client);
      await client.query("SAVEPOINT s");
      expect(await sqlState(insertItem(client, f, { amount: 0 }))).toBe(CHECK_VIOLATION);
      await client.query("ROLLBACK TO SAVEPOINT s");
      expect(await sqlState(insertItem(client, f, { amount: -1 }))).toBe(CHECK_VIOLATION);
    }));

  it("rejects fractional cents instead of rounding them", () =>
    inRollback(async (client) => {
      expect(
        await sqlState(insertItem(client, await fixtures(client), { amount: 10.5 })),
      ).toBe("22P02");
    }));

  it("rejects currencies other than USD", () =>
    inRollback(async (client) => {
      expect(
        await sqlState(insertItem(client, await fixtures(client), { currency: "EUR" })),
      ).toBe(CHECK_VIOLATION);
    }));

  it("rejects unknown payout item states", () =>
    inRollback(async (client) => {
      expect(
        await sqlState(insertItem(client, await fixtures(client), { state: "paid" })),
      ).toBe(CHECK_VIOLATION);
    }));

  it("requires a reason for a held item", () =>
    inRollback(async (client) => {
      expect(
        await sqlState(insertItem(client, await fixtures(client), { state: "held" })),
      ).toBe(CHECK_VIOLATION);
    }));

  it("requires a verified account before an item is approved", () =>
    inRollback(async (client) => {
      expect(
        await sqlState(insertItem(client, await fixtures(client), { state: "approved" })),
      ).toBe(CHECK_VIOLATION);
    }));

  it("rejects roles other than operator and approver", () =>
    inRollback(async (client) => {
      expect(
        await sqlState(
          client.query(
            "INSERT INTO users (email, name, role) VALUES ('x@example.com', 'X', 'admin')",
          ),
        ),
      ).toBe(CHECK_VIOLATION);
    }));

  it("allows only one active verification per payee", () =>
    inRollback(async (client) => {
      const { payeeId } = await fixtures(client);
      const insert = () =>
        client.query(
          `INSERT INTO verifications
             (payee_id, paypal_payer_id, verified_account, verified_at, status)
           VALUES ($1, 'PAYER', true, now(), 'active')`,
          [payeeId],
        );
      await insert();
      expect(await sqlState(insert())).toBe("23505");
    }));

  it("stops the same approver approving an item twice", () =>
    inRollback(async (client) => {
      const f = await fixtures(client);
      const approver = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, role)
         VALUES ('approver-test@example.com', 'A', 'approver') RETURNING id`,
      );
      const item = await client.query<{ id: string }>(
        `INSERT INTO payout_items
           (batch_id, line_number, payee_id, amount_cents, sender_item_id)
         VALUES ($1, 1, $2, 50000, 'schema-test-item') RETURNING id`,
        [f.batchId, f.payeeId],
      );
      const approve = () =>
        client.query(
          `INSERT INTO approvals (approver_id, payout_item_id, decision)
           VALUES ($1, $2, 'approved')`,
          [approver.rows[0].id, item.rows[0].id],
        );
      await approve();
      expect(await sqlState(approve())).toBe("23505");
    }));
});
