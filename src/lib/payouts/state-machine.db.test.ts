import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { verifyAuditLog } from "../audit/log";
import { sqlState, TEST_DATABASE_URL, useTestDatabase } from "../db/test-helpers";
import type { HoldReason } from "./holds";
import {
  approvePayoutItem,
  IllegalTransitionError,
  PayoutItemError,
  transitionPayoutItem,
} from "./state-machine";

const hold: HoldReason = {
  code: "duplicate_line",
  action: "hold",
  source: "rule",
  explanation: "Same payee and amount on line 2.",
  requiresSecondApprover: false,
};
const secondApproverHold: HoldReason = {
  ...hold,
  code: "first_payment_over_limit",
  explanation: "First payment of $450.00 is over $300.00.",
  requiresSecondApprover: true,
};
const block: HoldReason = { ...hold, code: "payee_not_verified", action: "block" };

async function user(client: Client, name: string, role: "operator" | "approver") {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING id",
    [`${name}-sm-test@example.com`, name, role],
  );
  return rows[0].id;
}

async function fixtures(client: Client) {
  const operator = await user(client, "operator", "operator");
  const approverA = await user(client, "approver-a", "approver");
  const approverB = await user(client, "approver-b", "approver");
  const payee = (
    await client.query<{ id: string }>(
      `INSERT INTO payees (display_name, contact_email, invited_by)
       VALUES ('SM Payee', 'sm-payee@example.com', $1) RETURNING id`,
      [operator],
    )
  ).rows[0].id;
  const verification = (
    await client.query<{ id: string }>(
      `INSERT INTO verifications (payee_id, paypal_payer_id, verified_account, verified_at, status)
       VALUES ($1, 'SMTESTPAYER01', true, now(), 'active') RETURNING id`,
      [payee],
    )
  ).rows[0].id;
  const batch = (
    await client.query<{ id: string }>(
      `INSERT INTO batches (sender_batch_id, uploaded_by) VALUES ('sm-test-batch', $1) RETURNING id`,
      [operator],
    )
  ).rows[0].id;
  let line = 0;
  const item = async () => {
    line++;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payout_items (batch_id, line_number, payee_id, amount_cents, sender_item_id)
       VALUES ($1, $2, $3, 45000, $4) RETURNING id`,
      [batch, line, payee, `sm-test-item-${line}`],
    );
    return rows[0].id;
  };
  return { operator, approverA, approverB, payee, verification, item };
}

async function stateOf(client: Client, itemId: string) {
  const { rows } = await client.query<{ state: string; hold_reasons: HoldReason[] }>(
    "SELECT state, hold_reasons FROM payout_items WHERE id = $1",
    [itemId],
  );
  return rows[0];
}

async function auditFor(client: Client, itemId: string) {
  const { rows } = await client.query<{ action: string; actor_type: string; actor_id: string | null; details: Record<string, unknown> }>(
    `SELECT action, actor_type, actor_id, details FROM audit_entries
     WHERE entity_type = 'payout_item' AND entity_id = $1 ORDER BY id`,
    [itemId],
  );
  return rows;
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
}

async function codeOf(promise: Promise<unknown>) {
  const err = await failure(promise);
  expect(err).toBeInstanceOf(PayoutItemError);
  return (err as PayoutItemError).code;
}

/** Moves a fresh item to ready, as the rule engine would. */
async function readyItem(client: Client, f: Awaited<ReturnType<typeof fixtures>>) {
  const id = await f.item();
  await transitionPayoutItem(client, {
    itemId: id, to: "ready", actor: { kind: "checks" }, verificationId: f.verification,
  });
  return id;
}

describe.skipIf(!TEST_DATABASE_URL)("payout item state machine in Postgres", () => {
  const inRollback = useTestDatabase();

  describe("transitionPayoutItem", () => {
    it("changes state and writes one audit entry in the same transaction", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await expect(
          transitionPayoutItem(client, {
            itemId: id, to: "ready", actor: { kind: "checks" }, verificationId: f.verification,
          }),
        ).resolves.toEqual({ from: "draft", to: "ready" });

        expect((await stateOf(client, id)).state).toBe("ready");
        expect(await auditFor(client, id)).toEqual([
          {
            action: "payout_item.transitioned",
            actor_type: "system",
            actor_id: null,
            details: { from: "draft", to: "ready", by: "checks", holds: [] },
          },
        ]);
        expect(await verifyAuditLog(client)).toEqual({ ok: true });
      }));

    it("runs a full happy path with an audit entry per step", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        await approvePayoutItem(client, { itemId: id, approverId: f.approverA });
        await transitionPayoutItem(client, { itemId: id, to: "sent", actor: { kind: "executor" } });
        await transitionPayoutItem(client, { itemId: id, to: "completed", actor: { kind: "paypal" } });

        expect((await stateOf(client, id)).state).toBe("completed");
        const transitions = (await auditFor(client, id))
          .filter((e) => e.action === "payout_item.transitioned")
          .map((e) => `${e.details.from}>${e.details.to}`);
        expect(transitions).toEqual([
          "draft>ready", "ready>approved", "approved>sent", "sent>completed",
        ]);
        expect(await verifyAuditLog(client)).toEqual({ ok: true });
      }));

    it("throws on an illegal transition and changes nothing", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        const err = await failure(
          transitionPayoutItem(client, { itemId: id, to: "sent", actor: { kind: "executor" } }),
        );
        expect(err).toBeInstanceOf(IllegalTransitionError);
        expect((await stateOf(client, id)).state).toBe("draft");
        expect(await auditFor(client, id)).toEqual([]);
      }));

    it("keeps the transaction usable after a rejected transition", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await failure(
          transitionPayoutItem(client, { itemId: id, to: "completed", actor: { kind: "paypal" } }),
        );
        await expect(
          transitionPayoutItem(client, { itemId: id, to: "cancelled", actor: { kind: "user", userId: f.operator } }),
        ).resolves.toEqual({ from: "draft", to: "cancelled" });
      }));

    it("rolls back the state change if the audit entry cannot be written", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        // A NUL character fails audit validation after the UPDATE has run.
        await failure(
          transitionPayoutItem(client, {
            itemId: id, to: "cancelled", actor: { kind: "user", userId: f.operator }, note: "a\u0000b",
          }),
        );
        expect((await stateOf(client, id)).state).toBe("draft");
        expect(await auditFor(client, id)).toEqual([]);
      }));

    it("records the user as the audit actor", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, {
          itemId: id, to: "cancelled", actor: { kind: "user", userId: f.operator }, note: "Wrong amount",
        });
        expect(await auditFor(client, id)).toMatchObject([
          {
            actor_type: "user",
            actor_id: f.operator,
            details: { from: "draft", to: "cancelled", by: "user", note: "Wrong amount" },
          },
        ]);
      }));

    it("appends holds and keeps earlier ones", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });
        await transitionPayoutItem(client, { itemId: id, to: "blocked", actor: { kind: "checks" }, holds: [block] });
        expect(await stateOf(client, id)).toEqual({ state: "blocked", hold_reasons: [hold, block] });
      }));

    it("adds holds to an item that is already held, with an audit entry", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });
        const aiHold: HoldReason = { ...hold, code: "document_name_mismatch", source: "ai" };
        await expect(
          transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "ai" }, holds: [aiHold] }),
        ).resolves.toEqual({ from: "held", to: "held" });

        expect(await stateOf(client, id)).toEqual({ state: "held", hold_reasons: [hold, aiHold] });
        expect((await auditFor(client, id)).at(-1)).toMatchObject({
          action: "payout_item.transitioned",
          actor_type: "system",
          details: { from: "held", to: "held", by: "ai", holds: ["document_name_mismatch"] },
        });
      }));

    it("needs at least one new reason to add holds", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });
        expect(
          await codeOf(transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [] })),
        ).toBe("invalid_holds");
      }));

    it("refuses to approve through the generic transition", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        expect(
          await codeOf(
            transitionPayoutItem(client, {
              itemId: id, to: "approved", actor: { kind: "user", userId: f.approverA },
            }),
          ),
        ).toBe("use_approve");
      }));

    it("rejects an unknown item and an unknown user", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        expect(
          await codeOf(
            transitionPayoutItem(client, {
              itemId: "00000000-0000-4000-8000-000000000000", to: "ready", actor: { kind: "checks" },
            }),
          ),
        ).toBe("not_found");
        expect(
          await codeOf(
            transitionPayoutItem(client, {
              itemId: await f.item(), to: "cancelled",
              actor: { kind: "user", userId: "00000000-0000-4000-8000-000000000000" },
            }),
          ),
        ).toBe("unknown_user");
      }));

    it("lets only checks set the verified account", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        expect(
          await codeOf(
            transitionPayoutItem(client, {
              itemId: await f.item(), to: "held", actor: { kind: "ai" },
              holds: [{ ...hold, source: "ai" }], verificationId: f.verification,
            }),
          ),
        ).toBe("invalid_request");
      }));

    it("refuses to run outside a transaction", async () => {
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await expect(
          transitionPayoutItem(client, {
            itemId: "00000000-0000-4000-8000-000000000000", to: "ready", actor: { kind: "checks" },
          }),
        ).rejects.toThrow(/transaction block/);
      } finally {
        await client.end();
      }
    });
  });

  describe("database guard", () => {
    it("rejects a direct state update", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        expect(
          await sqlState(client.query("UPDATE payout_items SET state = 'ready' WHERE id = $1", [id])),
        ).toBe("42501");
      }));

    it("rejects removing holds directly", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });
        expect(
          await sqlState(
            client.query("UPDATE payout_items SET hold_reasons = '[]' WHERE id = $1", [id]),
          ),
        ).toBe("42501");
      }));

    it("rejects inserting an item that is not a plain draft", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        const { rows } = await client.query<{ batch_id: string }>(
          "SELECT batch_id FROM payout_items WHERE id = $1",
          [id],
        );
        expect(
          await sqlState(
            client.query(
              `INSERT INTO payout_items (batch_id, line_number, payee_id, amount_cents, sender_item_id, state, verification_id)
               VALUES ($1, 99, $2, 100, 'sm-guard', 'approved', $3)`,
              [rows[0].batch_id, f.payee, f.verification],
            ),
          ),
        ).toBe("42501");
      }));

    it.each([
      ["removing a hold", "'[]'::jsonb"],
      ["editing a hold", `jsonb_set(hold_reasons, '{0,explanation}', '"edited"')`],
      ["reordering holds", "jsonb_build_array(hold_reasons->1, hold_reasons->0)"],
      ["replacing a hold", `jsonb_build_array(hold_reasons->0, '{"code":"other"}'::jsonb)`],
    ])("rejects %s even with the state machine flag on", (_label, expr) =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, {
          itemId: id, to: "held", actor: { kind: "checks" },
          holds: [hold, { ...hold, code: "shared_account" }],
        });
        await client.query("SELECT set_config('verified_payouts.state_machine', 'on', true)");
        expect(
          await sqlState(client.query(`UPDATE payout_items SET hold_reasons = ${expr} WHERE id = $1`, [id])),
        ).toBe("42501");
      }));

    it("allows appending a hold with the state machine flag on", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });
        await client.query("SELECT set_config('verified_payouts.state_machine', 'on', true)");
        await expect(
          client.query(
            `UPDATE payout_items SET hold_reasons = hold_reasons || '[{"code":"x"}]'::jsonb WHERE id = $1`,
            [id],
          ),
        ).resolves.toBeDefined();
      }));

    it("allows updates that do not touch state or holds", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await expect(
          client.query("UPDATE payout_items SET updated_at = now() WHERE id = $1", [id]),
        ).resolves.toBeDefined();
      }));

    it("turns the guard back on after a transition", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        expect(
          await sqlState(client.query("UPDATE payout_items SET state = 'sent' WHERE id = $1", [id])),
        ).toBe("42501");
      }));
  });

  describe("approvePayoutItem", () => {
    it("approves a ready item with one approver", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverA })).resolves
          .toEqual({ state: "approved", approvals: 1, required: 1 });
        expect((await auditFor(client, id)).map((e) => e.action)).toEqual([
          "payout_item.transitioned",
          "payout_item.approval_recorded",
          "payout_item.transitioned",
        ]);
      }));

    it("approves a held item directly", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, {
          itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold], verificationId: f.verification,
        });
        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverA })).resolves
          .toMatchObject({ state: "approved" });
      }));

    it("needs two different approvers for a second-approver hold", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, {
          itemId: id, to: "held", actor: { kind: "checks" },
          holds: [secondApproverHold], verificationId: f.verification,
        });

        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverA })).resolves
          .toEqual({ state: "held", approvals: 1, required: 2 });
        expect(await codeOf(approvePayoutItem(client, { itemId: id, approverId: f.approverA })))
          .toBe("already_approved");
        expect((await stateOf(client, id)).state).toBe("held");

        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverB })).resolves
          .toEqual({ state: "approved", approvals: 2, required: 2 });
      }));

    it("discards earlier approvals when a new hold is added", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, {
          itemId: id, to: "held", actor: { kind: "checks" },
          holds: [secondApproverHold], verificationId: f.verification,
        });
        await approvePayoutItem(client, { itemId: id, approverId: f.approverA });

        const aiHold: HoldReason = { ...hold, code: "document_name_mismatch", source: "ai" };
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "ai" }, holds: [aiHold] });
        expect((await auditFor(client, id)).at(-1)?.details).toMatchObject({ approvals_superseded: 1 });

        // B alone is not enough: A's approval predates the new hold.
        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverB })).resolves
          .toEqual({ state: "held", approvals: 1, required: 2 });
        // A can approve again after seeing it.
        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverA })).resolves
          .toEqual({ state: "approved", approvals: 2, required: 2 });
      }));

    it("needs a fresh approval after an approved item is held again", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        await approvePayoutItem(client, { itemId: id, approverId: f.approverA });
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });

        const { rows } = await client.query<{ superseded: boolean }>(
          "SELECT superseded_at IS NOT NULL AS superseded FROM approvals WHERE payout_item_id = $1",
          [id],
        );
        expect(rows).toEqual([{ superseded: true }]);
        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverA })).resolves
          .toEqual({ state: "approved", approvals: 1, required: 1 });
      }));

    it("keeps approvals when a transition adds no holds", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        await approvePayoutItem(client, { itemId: id, approverId: f.approverA });
        await transitionPayoutItem(client, { itemId: id, to: "sent", actor: { kind: "executor" } });
        const { rows } = await client.query(
          "SELECT 1 FROM approvals WHERE payout_item_id = $1 AND superseded_at IS NULL",
          [id],
        );
        expect(rows).toHaveLength(1);
      }));

    it("rejects an approver who invited the payee, recording nothing", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        await client.query("UPDATE payees SET invited_by = $1 WHERE id = $2", [f.approverA, f.payee]);
        const id = await readyItem(client, f);
        expect(await codeOf(approvePayoutItem(client, { itemId: id, approverId: f.approverA })))
          .toBe("invited_payee");
        const { rows } = await client.query("SELECT 1 FROM approvals WHERE payout_item_id = $1", [id]);
        expect(rows).toEqual([]);
        expect((await stateOf(client, id)).state).toBe("ready");
      }));

    it("rejects the approver who last changed the payee", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        await client.query("UPDATE payees SET last_changed_by = $1 WHERE id = $2", [f.approverA, f.payee]);
        const id = await readyItem(client, f);
        expect(await codeOf(approvePayoutItem(client, { itemId: id, approverId: f.approverA })))
          .toBe("changed_payee");
      }));

    it("rejects an approver who changed the payee before someone else did", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const { appendAuditEntry } = await import("../audit/log");
        await appendAuditEntry(client, {
          occurredAt: new Date(), actorType: "user", actorId: f.approverA,
          action: "payee.updated", entityType: "payee", entityId: f.payee, details: {},
        });
        await client.query("UPDATE payees SET last_changed_by = $1 WHERE id = $2", [f.operator, f.payee]);
        const id = await readyItem(client, f);
        expect(await codeOf(approvePayoutItem(client, { itemId: id, approverId: f.approverA })))
          .toBe("changed_payee");
        // A different approver is still allowed.
        await expect(approvePayoutItem(client, { itemId: id, approverId: f.approverB })).resolves
          .toMatchObject({ state: "approved" });
      }));

    it("rejects an operator", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await readyItem(client, f);
        expect(await codeOf(approvePayoutItem(client, { itemId: id, approverId: f.operator })))
          .toBe("not_an_approver");
      }));

    it("rejects approving an item that is not ready or held", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        const err = await failure(approvePayoutItem(client, { itemId: id, approverId: f.approverA }));
        expect(err).toBeInstanceOf(IllegalTransitionError);
        expect(err).toMatchObject({ from: "draft", to: "approved" });
      }));

    it("rejects approving an item with no verified account", () =>
      inRollback(async (client) => {
        const f = await fixtures(client);
        const id = await f.item();
        await transitionPayoutItem(client, { itemId: id, to: "held", actor: { kind: "checks" }, holds: [hold] });
        expect(await codeOf(approvePayoutItem(client, { itemId: id, approverId: f.approverA })))
          .toBe("no_verified_account");
      }));
  });
});
