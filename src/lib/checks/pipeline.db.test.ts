import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { verifyAuditLog } from "../audit/log";
import { TEST_DATABASE_URL, useTestDatabase } from "../db/test-helpers";
import { approvePayoutItem } from "../payouts/state-machine";
import { DEFAULT_CHECK_CONFIG } from "./config";
import { BatchCheckError, checkBatch } from "./pipeline";

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

type PayeeSpec = {
  name: string;
  verification?: { payerId: string; verifiedAccount?: boolean; verifiedName?: string };
  /** Completed payments in an earlier batch, 30 days ago. */
  history?: number[];
};

async function setup(client: Client) {
  const user = async (name: string, role: "operator" | "approver") =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING id",
        [`${name.toLowerCase().replace(/ /g, ".")}@pipeline.example`, name, role],
      )
    ).rows[0].id;
  const operator = await user("Olivia Pipeline", "operator");
  const approverA = await user("Avery Pipeline", "approver");
  const approverB = await user("Blake Pipeline", "approver");

  const batch = async (sender: string) =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO batches (sender_batch_id, uploaded_by) VALUES ($1, $2) RETURNING id",
        [sender, operator],
      )
    ).rows[0].id;
  const earlier = await batch("pipeline-earlier");
  let earlierLine = 0;

  const payee = async (spec: PayeeSpec) => {
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO payees (display_name, contact_email, invited_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [spec.name, `${spec.name.toLowerCase().replace(/ /g, ".")}@payee.example`, operator],
      )
    ).rows[0].id;
    let verificationId: string | null = null;
    if (spec.verification) {
      verificationId = (
        await client.query<{ id: string }>(
          `INSERT INTO verifications (payee_id, paypal_payer_id, verified_account,
             verified_name, email, email_verified, verified_at, status)
           VALUES ($1, $2, $3, $4, $5, true, now(), 'active') RETURNING id`,
          [
            id,
            spec.verification.payerId,
            spec.verification.verifiedAccount ?? true,
            spec.verification.verifiedName ?? spec.name,
            `${spec.verification.payerId.toLowerCase()}@paypal.example`,
          ],
        )
      ).rows[0].id;
    }
    if (spec.history?.length) {
      // Fixture shortcut: completed history inserted directly, bypassing the
      // state machine guard for this transaction only.
      await client.query("SELECT set_config('verified_payouts.state_machine', 'on', true)");
      for (const amount of spec.history) {
        earlierLine++;
        await client.query(
          `INSERT INTO payout_items (batch_id, line_number, payee_id, verification_id,
             amount_cents, state, sender_item_id, created_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7)`,
          [earlier, earlierLine, id, verificationId, amount, `pipeline-earlier-${earlierLine}`,
            new Date(NOW.getTime() - 30 * DAY)],
        );
      }
      await client.query("SELECT set_config('verified_payouts.state_machine', '', true)");
    }
    return id;
  };

  const target = await batch("pipeline-target");
  let line = 0;
  const addLine = async (
    payeeId: string,
    amount: number,
    receiver?: { type: "paypal_id" | "email"; value: string },
  ) => {
    line++;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payout_items (batch_id, line_number, payee_id, amount_cents,
         sender_item_id, receiver_type, receiver_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [target, line, payeeId, amount, `pipeline-target-${line}`, receiver?.type ?? null, receiver?.value ?? null],
    );
    return rows[0].id;
  };

  return { operator, approverA, approverB, target, payee, addLine };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const normal = [10000, 12000, 11000];

/** One line per rule outcome, plus a clean line. */
async function mixedBatch(s: Setup) {
  const clean = await s.payee({ name: "Clean Carla", verification: { payerId: "CLEANCARLA01" }, history: normal });
  const fresh = await s.payee({ name: "New Nina", verification: { payerId: "NEWNINA00001" } });
  const unverified = await s.payee({ name: "Unverified Uma" });
  const diverted = await s.payee({ name: "Diverted Dan", verification: { payerId: "DIVERTEDDAN1" }, history: normal });
  const dup = await s.payee({ name: "Duplicate Dee", verification: { payerId: "DUPDEE000001" }, history: normal });
  const shared = await s.payee({ name: "Shared Sam", verification: { payerId: "SHAREDACCT01" }, history: normal });
  await s.payee({ name: "Shared Sue", verification: { payerId: "SHAREDACCT01" } });
  const flagged = await s.payee({
    name: "Flagged Fay", verification: { payerId: "FLAGGEDFAY01", verifiedAccount: false }, history: normal,
  });
  const staffLike = await s.payee({
    name: "Not Staff", verification: { payerId: "STAFFLIKE001", verifiedName: "Avery Pipeline" }, history: normal,
  });
  const spike = await s.payee({ name: "Spike Sid", verification: { payerId: "SPIKESID0001" }, history: normal });

  return {
    clean: await s.addLine(clean, 11000, { type: "paypal_id", value: "CLEANCARLA01" }),
    firstPayment: await s.addLine(fresh, 45000),
    unverified: await s.addLine(unverified, 5000),
    diverted: await s.addLine(diverted, 11000, { type: "email", value: "new-account@attacker.example" }),
    dupA: await s.addLine(dup, 8000),
    dupB: await s.addLine(dup, 8000),
    shared: await s.addLine(shared, 11000),
    flagged: await s.addLine(flagged, 11000),
    staffLike: await s.addLine(staffLike, 11000),
    spike: await s.addLine(spike, 50000),
  };
}

async function itemRow(client: Client, id: string) {
  const { rows } = await client.query<{
    state: string;
    hold_reasons: { code: string; action: string; explanation: string; requiresSecondApprover: boolean }[];
    verification_id: string | null;
  }>("SELECT state, hold_reasons, verification_id FROM payout_items WHERE id = $1", [id]);
  return rows[0];
}

async function codeOf(promise: Promise<unknown>) {
  const err = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BatchCheckError);
  return (err as BatchCheckError).code;
}

describe.skipIf(!TEST_DATABASE_URL)("checkBatch in Postgres", () => {
  const inRollback = useTestDatabase();

  it("moves a mixed batch of clean, held and blocked items to the right states", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      const result = await checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW });

      expect({ ready: result.ready, held: result.held, blocked: result.blocked }).toEqual({
        ready: 1, held: 7, blocked: 2,
      });

      const expected: Record<keyof typeof lines, [string, string[]]> = {
        clean: ["ready", []],
        firstPayment: ["held", ["first_payment_over_limit"]],
        unverified: ["blocked", ["payee_not_verified"]],
        diverted: ["blocked", ["account_differs_from_verified"]],
        dupA: ["held", ["duplicate_line"]],
        dupB: ["held", ["duplicate_line"]],
        shared: ["held", ["shared_account"]],
        flagged: ["held", ["paypal_account_unverified"]],
        staffLike: ["held", ["matches_staff_member"]],
        spike: ["held", ["amount_over_median"]],
      };
      for (const [key, [state, codes]] of Object.entries(expected)) {
        const row = await itemRow(client, lines[key as keyof typeof lines]);
        expect({ key, state: row.state, codes: row.hold_reasons.map((h) => h.code) }).toEqual({
          key, state, codes,
        });
      }
    }));

  it("stores the same reasons the result returns", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      await mixedBatch(s);
      const result = await checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW });
      for (const outcome of result.items) {
        expect((await itemRow(client, outcome.itemId)).hold_reasons).toEqual(outcome.reasons);
      }
    }));

  it("links every verified payee's item to its verified account", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      await checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW });
      expect((await itemRow(client, lines.clean)).verification_id).not.toBeNull();
      expect((await itemRow(client, lines.firstPayment)).verification_id).not.toBeNull();
      expect((await itemRow(client, lines.diverted)).verification_id).not.toBeNull();
      expect((await itemRow(client, lines.unverified)).verification_id).toBeNull();
    }));

  it("flags same-batch duplicates without counting them as earlier payments", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      await checkBatch(client, s.target, { config: { ...DEFAULT_CHECK_CONFIG, duplicateWindowDays: 365 }, now: NOW });
      expect((await itemRow(client, lines.dupA)).hold_reasons[0].explanation).toBe(
        "Same payee and amount ($80.00) as line 6 of this batch.",
      );
      expect((await itemRow(client, lines.dupB)).hold_reasons[0].explanation).toBe(
        "Same payee and amount ($80.00) as line 5 of this batch.",
      );
    }));

  it("flags a payment repeated from an earlier batch within the window", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const p = await s.payee({ name: "Repeat Ray", verification: { payerId: "REPEATRAY001" }, history: normal });
      const id = await s.addLine(p, 12000);
      await checkBatch(client, s.target, { config: { ...DEFAULT_CHECK_CONFIG, duplicateWindowDays: 31 }, now: NOW });
      expect(await itemRow(client, id)).toMatchObject({
        state: "held",
        hold_reasons: [{ code: "duplicate_line", explanation: "Same payee and amount ($120.00) as a payment in the last 31 days." }],
      });
    }));

  it("uses the configured limits", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      await checkBatch(client, s.target, {
        config: { ...DEFAULT_CHECK_CONFIG, firstPaymentLimitCents: 50000, medianMultiplierPercent: 500 },
        now: NOW,
      });
      expect((await itemRow(client, lines.firstPayment)).state).toBe("ready");
      expect((await itemRow(client, lines.spike)).state).toBe("ready");
    }));

  it("marks the batch checked and audits every item and the batch", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      await checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW });

      const { rows: batch } = await client.query("SELECT status FROM batches WHERE id = $1", [s.target]);
      expect(batch).toEqual([{ status: "checked" }]);

      const { rows: entries } = await client.query<{ entity_id: string; action: string; details: Record<string, unknown> }>(
        `SELECT entity_id, action, details FROM audit_entries
         WHERE (entity_type = 'payout_item' AND entity_id = ANY($1)) OR (entity_type = 'batch' AND entity_id = $2)
         ORDER BY id`,
        [Object.values(lines), s.target],
      );
      expect(entries).toHaveLength(Object.keys(lines).length + 1);
      expect(entries.slice(0, -1).every((e) => e.action === "payout_item.transitioned" && e.details.by === "checks")).toBe(true);
      expect(entries.at(-1)).toMatchObject({
        action: "batch.checked",
        details: { ready: 1, held: 7, blocked: 2 },
      });
      expect(await verifyAuditLog(client)).toEqual({ ok: true });
    }));

  it("leaves a first payment over the limit needing two approvers", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      await checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW });
      await expect(approvePayoutItem(client, { itemId: lines.firstPayment, approverId: s.approverA }))
        .resolves.toEqual({ state: "held", approvals: 1, required: 2 });
      await expect(approvePayoutItem(client, { itemId: lines.firstPayment, approverId: s.approverB }))
        .resolves.toEqual({ state: "approved", approvals: 2, required: 2 });
    }));

  it("refuses to check a batch twice", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      await mixedBatch(s);
      await checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW });
      expect(await codeOf(checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW }))).toBe("not_draft");
    }));

  it("changes nothing if any item is not a draft", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      const { transitionPayoutItem } = await import("../payouts/state-machine");
      await transitionPayoutItem(client, { itemId: lines.spike, to: "cancelled", actor: { kind: "user", userId: s.operator } });

      expect(await codeOf(checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW }))).toBe("item_not_draft");
      expect((await itemRow(client, lines.clean)).state).toBe("draft");
      const { rows } = await client.query("SELECT status FROM batches WHERE id = $1", [s.target]);
      expect(rows).toEqual([{ status: "draft" }]);
    }));

  it("rolls back every item if one fails partway through", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      const lines = await mixedBatch(s);
      // Make the last line fail inside the state machine after earlier lines
      // have moved: a CHECK constraint the pipeline cannot satisfy.
      await client.query(
        `ALTER TABLE payout_items ADD CONSTRAINT pipeline_test_fail
         CHECK (state <> 'held' OR amount_cents <> 50000) NOT VALID`,
      );
      await expect(checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG, now: NOW })).rejects.toThrow();
      expect((await itemRow(client, lines.clean)).state).toBe("draft");
      expect((await itemRow(client, lines.firstPayment)).state).toBe("draft");
      const { rows } = await client.query("SELECT status FROM batches WHERE id = $1", [s.target]);
      expect(rows).toEqual([{ status: "draft" }]);
    }));

  it("rejects an unknown batch and an empty batch", () =>
    inRollback(async (client) => {
      const s = await setup(client);
      expect(await codeOf(checkBatch(client, "00000000-0000-4000-8000-000000000000", { config: DEFAULT_CHECK_CONFIG })))
        .toBe("not_found");
      expect(await codeOf(checkBatch(client, s.target, { config: DEFAULT_CHECK_CONFIG }))).toBe("empty_batch");
    }));

  it("refuses to run outside a transaction", async () => {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await expect(
        checkBatch(client, "00000000-0000-4000-8000-000000000000", { config: DEFAULT_CHECK_CONFIG }),
      ).rejects.toThrow(/transaction block/);
    } finally {
      await client.end();
    }
  });
});
