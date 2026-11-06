import type { ClientBase } from "pg";
import { appendAuditEntry } from "../audit/log";
import type { HoldReason } from "../payouts/holds";
import { transitionPayoutItem, type PayoutItemState } from "../payouts/state-machine";
import { loadCheckConfig, type CheckConfig } from "./config";
import {
  runChecks,
  type ActiveVerification,
  type CheckContext,
  type CheckItem,
  type HistoryItem,
} from "./rules";

export class BatchCheckError extends Error {
  constructor(
    readonly code: "not_found" | "not_draft" | "empty_batch" | "item_not_draft",
    message: string,
  ) {
    super(message);
    this.name = "BatchCheckError";
  }
}

export type ItemCheckOutcome = {
  itemId: string;
  lineNumber: number;
  outcome: "ready" | "held" | "blocked";
  reasons: HoldReason[];
};

export type BatchCheckResult = {
  batchId: string;
  ready: number;
  held: number;
  blocked: number;
  items: ItemCheckOutcome[];
};

type ItemRow = {
  id: string;
  line_number: number;
  payee_id: string;
  amount_cents: string;
  state: PayoutItemState;
  receiver_type: "paypal_id" | "email" | null;
  receiver_value: string | null;
};

type VerificationRow = {
  id: string;
  payee_id: string;
  paypal_payer_id: string;
  verified_account: boolean;
  verified_name: string | null;
  email: string | null;
};

/** bigint comes back from pg as a string; refuse anything unsafe as a number. */
function cents(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Amount ${value} is out of range`);
  return n;
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/**
 * Runs the rule checks on every item of a draft batch and moves each item
 * to ready, held or blocked through the state machine, then marks the batch
 * checked. Must run inside the caller's transaction: if any item fails, no
 * item or batch changes.
 */
export async function checkBatch(
  client: ClientBase,
  batchId: string,
  options: { config?: CheckConfig; now?: Date } = {},
): Promise<BatchCheckResult> {
  const config = options.config ?? loadCheckConfig();
  const now = options.now ?? new Date();

  // Fails with "can only be used in transaction blocks" outside a transaction.
  await client.query("SAVEPOINT batch_check");
  try {
    const result = await checkLockedBatch(client, batchId, config, now);
    await client.query("RELEASE SAVEPOINT batch_check");
    return result;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT batch_check");
    throw err;
  }
}

async function checkLockedBatch(
  client: ClientBase,
  batchId: string,
  config: CheckConfig,
  now: Date,
): Promise<BatchCheckResult> {
  const batch = await client.query<{ status: string }>(
    "SELECT status FROM batches WHERE id = $1 FOR UPDATE",
    [batchId],
  );
  if (!batch.rows[0]) throw new BatchCheckError("not_found", `Batch ${batchId} not found`);
  if (batch.rows[0].status !== "draft") {
    throw new BatchCheckError("not_draft", `Batch is ${batch.rows[0].status}; only draft batches are checked`);
  }

  const { rows: items } = await client.query<ItemRow>(
    `SELECT id, line_number, payee_id, amount_cents::text AS amount_cents, state,
            receiver_type, receiver_value
     FROM payout_items WHERE batch_id = $1 ORDER BY line_number FOR UPDATE`,
    [batchId],
  );
  if (items.length === 0) throw new BatchCheckError("empty_batch", "Batch has no items");
  const notDraft = items.find((i) => i.state !== "draft");
  if (notDraft) {
    throw new BatchCheckError(
      "item_not_draft",
      `Line ${notDraft.line_number} is ${notDraft.state}; every item must be draft`,
    );
  }

  const payeeIds = [...new Set(items.map((i) => i.payee_id))];

  const { rows: verifications } = await client.query<VerificationRow>(
    `SELECT id, payee_id, paypal_payer_id, verified_account, verified_name, email
     FROM verifications WHERE status = 'active' AND payee_id = ANY($1::uuid[])`,
    [payeeIds],
  );
  const verificationByPayee = new Map(verifications.map((v) => [v.payee_id, v]));

  // Earlier batches only: this batch's own lines are passed separately, so a
  // line is never a "recent payment" duplicate of itself.
  const { rows: history } = await client.query<{
    payee_id: string;
    amount_cents: string;
    state: PayoutItemState;
    created_at: Date;
  }>(
    `SELECT payee_id, amount_cents::text AS amount_cents, state, created_at
     FROM payout_items WHERE payee_id = ANY($1::uuid[]) AND batch_id <> $2`,
    [payeeIds, batchId],
  );
  const historyByPayee = groupBy(history, (h) => h.payee_id);

  const { rows: sharing } = await client.query<{ payee_id: string; paypal_payer_id: string }>(
    `SELECT payee_id, paypal_payer_id FROM verifications
     WHERE status = 'active' AND paypal_payer_id = ANY($1::text[])`,
    [verifications.map((v) => v.paypal_payer_id)],
  );
  const payeesByAccount = groupBy(sharing, (s) => s.paypal_payer_id);

  const { rows: staff } = await client.query<{ name: string; email: string }>(
    "SELECT name, email FROM users",
  );

  const batchLines = items.map((i) => ({
    lineNumber: i.line_number,
    payeeId: i.payee_id,
    amountCents: cents(i.amount_cents),
  }));

  const outcomes: ItemCheckOutcome[] = [];
  for (const row of items) {
    const v = verificationByPayee.get(row.payee_id);
    const verification: ActiveVerification | null = v
      ? {
          payerId: v.paypal_payer_id,
          verifiedAccount: v.verified_account,
          verifiedName: v.verified_name,
          email: v.email,
        }
      : null;
    const item: CheckItem = {
      lineNumber: row.line_number,
      payeeId: row.payee_id,
      amountCents: cents(row.amount_cents),
      receiver:
        row.receiver_type && row.receiver_value
          ? { type: row.receiver_type, value: row.receiver_value }
          : null,
    };
    const ctx: CheckContext = {
      payee: { id: row.payee_id },
      verification,
      history: (historyByPayee.get(row.payee_id) ?? []).map(
        (h): HistoryItem => ({
          amountCents: cents(h.amount_cents),
          state: h.state,
          createdAt: h.created_at,
        }),
      ),
      batch: batchLines,
      sharedAccountPayeeIds: v
        ? (payeesByAccount.get(v.paypal_payer_id) ?? []).map((s) => s.payee_id)
        : [],
      staff,
      now,
    };

    const { outcome, reasons } = runChecks(item, ctx, config);
    await transitionPayoutItem(client, {
      itemId: row.id,
      to: outcome,
      actor: { kind: "checks" },
      ...(outcome === "ready" ? {} : { holds: reasons }),
      ...(v ? { verificationId: v.id } : {}),
    });
    outcomes.push({ itemId: row.id, lineNumber: row.line_number, outcome, reasons });
  }

  const count = (o: ItemCheckOutcome["outcome"]) => outcomes.filter((x) => x.outcome === o).length;
  const result: BatchCheckResult = {
    batchId,
    ready: count("ready"),
    held: count("held"),
    blocked: count("blocked"),
    items: outcomes,
  };

  await client.query("UPDATE batches SET status = 'checked' WHERE id = $1", [batchId]);
  await appendAuditEntry(client, {
    occurredAt: now,
    actorType: "system",
    actorId: null,
    action: "batch.checked",
    entityType: "batch",
    entityId: batchId,
    details: { ready: result.ready, held: result.held, blocked: result.blocked },
  });
  return result;
}
