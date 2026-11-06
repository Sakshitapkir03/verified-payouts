import type { ClientBase } from "pg";
import { appendAuditEntry } from "../audit/log";
import { checkApprover } from "./approval-rules";
import {
  HoldReasonsSchema,
  requiredApprovals,
  type HoldReason,
} from "./holds";

/**
 * Payout item states from docs/SCOPE.md:
 *
 *   draft → held | ready → approved → sent → completed | unclaimed | returned | failed
 *   plus blocked and cancelled.
 *
 * The full table, including where blocked and cancelled can come from, is
 * TRANSITIONS below. Every state change goes through this module.
 */
export const PAYOUT_ITEM_STATES = [
  "draft",
  "held",
  "ready",
  "approved",
  "sent",
  "completed",
  "unclaimed",
  "returned",
  "failed",
  "blocked",
  "cancelled",
] as const;

export type PayoutItemState = (typeof PAYOUT_ITEM_STATES)[number];

/**
 * Who causes a transition:
 * - checks: the rule engine. ai: AI review, which may only add holds.
 * - user: an operator or approver acting in the app.
 * - approval: enough approvers have approved. Only approvePayoutItem uses it.
 * - executor: the only code that sends payouts.
 * - paypal: webhooks and status sync reporting PayPal's result.
 */
export type Actor =
  | { kind: "checks" }
  | { kind: "ai" }
  | { kind: "user"; userId: string; role: "operator" | "approver" }
  | { kind: "approval"; userId: string }
  | { kind: "executor" }
  | { kind: "paypal" };

export type ActorKind = Actor["kind"];

type TransitionTable = {
  readonly [From in PayoutItemState]: {
    readonly [To in PayoutItemState]?: readonly ActorKind[];
  };
};

export const TRANSITIONS: TransitionTable = {
  draft: {
    ready: ["checks"],
    held: ["checks", "ai"],
    blocked: ["checks"],
    cancelled: ["user"],
  },
  // Approvers review holds and approve; nothing moves a held item back to
  // ready, so a hold is only ever cleared by an approval. held → held adds
  // more hold reasons; reasons are never removed.
  held: {
    held: ["checks", "ai"],
    approved: ["approval"],
    blocked: ["checks"],
    cancelled: ["user"],
  },
  ready: {
    approved: ["approval"],
    held: ["checks", "ai"],
    blocked: ["checks"],
    cancelled: ["user"],
  },
  // Rechecked before sending, so an approved item can still be held or blocked.
  approved: {
    sent: ["executor"],
    held: ["checks", "ai"],
    blocked: ["checks"],
    cancelled: ["user"],
  },
  sent: {
    completed: ["paypal"],
    unclaimed: ["paypal"],
    returned: ["paypal"],
    failed: ["paypal"],
  },
  // Unclaimed items may be claimed later, returned after PayPal's claim
  // period, or cancelled through the Payouts API.
  unclaimed: {
    completed: ["paypal"],
    returned: ["paypal"],
    cancelled: ["paypal"],
  },
  // A blocked item is never sent; it can only be cancelled and re-uploaded.
  blocked: {
    cancelled: ["user"],
  },
  completed: {},
  returned: {},
  failed: {},
  cancelled: {},
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: PayoutItemState,
    readonly to: PayoutItemState,
    readonly actor: ActorKind,
  ) {
    super(`Illegal payout item transition ${from} → ${to} by ${actor}`);
    this.name = "IllegalTransitionError";
  }
}

export class PayoutItemError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "unknown_user"
      | "invalid_holds"
      | "invalid_request"
      | "use_approve"
      | "no_verified_account"
      | "not_an_approver"
      | "invited_payee"
      | "changed_payee"
      | "already_approved",
    message: string,
  ) {
    super(message);
    this.name = "PayoutItemError";
  }
}

export function canTransition(
  from: PayoutItemState,
  to: PayoutItemState,
  actor: ActorKind,
): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export function assertTransition(
  from: PayoutItemState,
  to: PayoutItemState,
  actor: ActorKind,
): void {
  if (!canTransition(from, to, actor)) {
    throw new IllegalTransitionError(from, to, actor);
  }
}

/** Checks the holds a transition carries. Pure, so it is unit tested directly. */
export function validateTransitionHolds(
  to: PayoutItemState,
  actor: ActorKind,
  holds: readonly HoldReason[] | undefined,
): HoldReason[] {
  if (to !== "held" && to !== "blocked") {
    if (holds?.length) {
      throw new PayoutItemError("invalid_holds", `Holds are not allowed when moving to ${to}`);
    }
    return [];
  }
  const parsed = HoldReasonsSchema.safeParse(holds ?? []);
  if (!parsed.success || parsed.data.length === 0) {
    throw new PayoutItemError("invalid_holds", `Moving to ${to} needs at least one valid reason`);
  }
  const reasons = parsed.data;
  if (to === "held" && reasons.some((h) => h.action === "block")) {
    throw new PayoutItemError("invalid_holds", "A block reason must move the item to blocked");
  }
  if (to === "blocked" && !reasons.some((h) => h.action === "block")) {
    throw new PayoutItemError("invalid_holds", "Moving to blocked needs a block reason");
  }
  if (actor === "ai" && reasons.some((h) => h.source !== "ai")) {
    throw new PayoutItemError("invalid_holds", "AI may only add AI holds");
  }
  if (actor === "checks" && reasons.some((h) => h.source !== "rule")) {
    throw new PayoutItemError("invalid_holds", "The rule engine may only add rule holds");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Database. Every function here must run inside the caller's transaction.

/** Actor as passed by callers. A user's role is loaded from the database. */
export type ActorInput =
  | { kind: "checks" }
  | { kind: "ai" }
  | { kind: "user"; userId: string }
  | { kind: "executor" }
  | { kind: "paypal" };

export type TransitionRequest = {
  itemId: string;
  to: PayoutItemState;
  actor: ActorInput;
  holds?: readonly HoldReason[];
  /** The verified account the item pays; only checks may set it. */
  verificationId?: string;
  note?: string;
};

export type TransitionResult = { from: PayoutItemState; to: PayoutItemState };

type ItemRow = {
  state: PayoutItemState;
  payee_id: string;
  verification_id: string | null;
  hold_reasons: HoldReason[];
};

async function lockItem(client: ClientBase, itemId: string): Promise<ItemRow> {
  const { rows } = await client.query<ItemRow>(
    `SELECT state, payee_id, verification_id, hold_reasons
     FROM payout_items WHERE id = $1 FOR UPDATE`,
    [itemId],
  );
  if (!rows[0]) throw new PayoutItemError("not_found", `Payout item ${itemId} not found`);
  return rows[0];
}

async function loadUserRole(
  client: ClientBase,
  userId: string,
): Promise<"operator" | "approver"> {
  const { rows } = await client.query<{ role: "operator" | "approver" }>(
    "SELECT role FROM users WHERE id = $1",
    [userId],
  );
  if (!rows[0]) throw new PayoutItemError("unknown_user", `User ${userId} not found`);
  return rows[0].role;
}

async function resolveActor(client: ClientBase, input: ActorInput): Promise<Actor> {
  if (input.kind !== "user") return input;
  return { ...input, role: await loadUserRole(client, input.userId) };
}

/** Runs `fn` in a savepoint; outside a transaction the SAVEPOINT itself fails. */
async function inSavepoint<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query("SAVEPOINT payout_state");
  try {
    const result = await fn();
    await client.query("RELEASE SAVEPOINT payout_state");
    return result;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT payout_state");
    throw err;
  }
}

async function applyTransition(
  client: ClientBase,
  item: ItemRow,
  req: Omit<TransitionRequest, "actor"> & { actor: Actor },
): Promise<TransitionResult> {
  const from = item.state;
  assertTransition(from, req.to, req.actor.kind);
  const holds = validateTransitionHolds(req.to, req.actor.kind, req.holds);
  if (req.verificationId !== undefined && req.actor.kind !== "checks") {
    throw new PayoutItemError("invalid_request", "Only checks may set the verified account");
  }

  await client.query("SELECT set_config('verified_payouts.state_machine', 'on', true)");
  await client.query(
    `UPDATE payout_items
     SET state = $2,
         hold_reasons = hold_reasons || $3::jsonb,
         verification_id = COALESCE($4, verification_id),
         updated_at = now()
     WHERE id = $1`,
    [req.itemId, req.to, JSON.stringify(holds), req.verificationId ?? null],
  );
  await client.query("SELECT set_config('verified_payouts.state_machine', '', true)");

  // New holds invalidate earlier approvals: those approvers haven't seen them.
  let superseded = 0;
  if (holds.length > 0) {
    const result = await client.query(
      `UPDATE approvals SET superseded_at = now()
       WHERE payout_item_id = $1 AND superseded_at IS NULL`,
      [req.itemId],
    );
    superseded = result.rowCount ?? 0;
  }

  const isUser = req.actor.kind === "user" || req.actor.kind === "approval";
  await appendAuditEntry(client, {
    occurredAt: new Date(),
    actorType: isUser ? "user" : "system",
    actorId: "userId" in req.actor ? req.actor.userId : null,
    action: "payout_item.transitioned",
    entityType: "payout_item",
    entityId: req.itemId,
    details: {
      from,
      to: req.to,
      by: req.actor.kind,
      holds: holds.map((h) => h.code),
      ...(superseded ? { approvals_superseded: superseded } : {}),
      ...(req.note ? { note: req.note } : {}),
    },
  });
  return { from, to: req.to };
}

/**
 * Moves an item to a new state and writes the audit entry in the same
 * transaction. Approval has its own entry point, approvePayoutItem.
 */
export async function transitionPayoutItem(
  client: ClientBase,
  req: TransitionRequest,
): Promise<TransitionResult> {
  if (req.to === "approved") {
    throw new PayoutItemError("use_approve", "Use approvePayoutItem to approve items");
  }
  return inSavepoint(client, async () => {
    const item = await lockItem(client, req.itemId);
    const actor = await resolveActor(client, req.actor);
    return applyTransition(client, item, { ...req, actor });
  });
}

export type ApprovalResult = {
  state: PayoutItemState;
  approvals: number;
  required: 1 | 2;
};

/**
 * Records one approver's approval. The item moves to approved once enough
 * different approvers have approved since its holds last changed: two if
 * any hold needs a second approver, otherwise one.
 */
export async function approvePayoutItem(
  client: ClientBase,
  req: { itemId: string; approverId: string; note?: string },
): Promise<ApprovalResult> {
  return inSavepoint(client, async () => {
    const item = await lockItem(client, req.itemId);
    assertTransition(item.state, "approved", "approval");

    const role = await loadUserRole(client, req.approverId);
    const payee = await client.query<{ invited_by: string; last_changed_by: string | null }>(
      "SELECT invited_by, last_changed_by FROM payees WHERE id = $1",
      [item.payee_id],
    );
    // Anyone with an audit entry on the payee has changed it, not just the
    // most recent editor recorded on the row.
    const editors = await client.query<{ actor_id: string }>(
      `SELECT DISTINCT actor_id FROM audit_entries
       WHERE entity_type = 'payee' AND entity_id = $1 AND actor_type = 'user'`,
      [item.payee_id],
    );
    const check = checkApprover({
      approverId: req.approverId,
      approverRole: role,
      invitedBy: payee.rows[0].invited_by,
      changedBy: [payee.rows[0].last_changed_by, ...editors.rows.map((r) => r.actor_id)],
    });
    if (!check.ok) {
      throw new PayoutItemError(check.reason, `Approver may not approve this item: ${check.reason}`);
    }
    if (!item.verification_id) {
      throw new PayoutItemError("no_verified_account", "Item has no verified account to pay");
    }

    const inserted = await client.query(
      `INSERT INTO approvals (approver_id, payout_item_id, decision, note)
       VALUES ($1, $2, 'approved', $3)
       ON CONFLICT (payout_item_id, approver_id)
         WHERE payout_item_id IS NOT NULL AND superseded_at IS NULL
       DO NOTHING`,
      [req.approverId, req.itemId, req.note ?? null],
    );
    if (!inserted.rowCount) {
      throw new PayoutItemError("already_approved", "This approver has already approved this item");
    }
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approvals
       WHERE payout_item_id = $1 AND decision = 'approved' AND superseded_at IS NULL`,
      [req.itemId],
    );
    const approvals = rows[0].n;
    const required = requiredApprovals(item.hold_reasons);

    await appendAuditEntry(client, {
      occurredAt: new Date(),
      actorType: "user",
      actorId: req.approverId,
      action: "payout_item.approval_recorded",
      entityType: "payout_item",
      entityId: req.itemId,
      details: { approvals, required },
    });

    if (approvals < required) {
      return { state: item.state, approvals, required };
    }
    const { to } = await applyTransition(client, item, {
      itemId: req.itemId,
      to: "approved",
      actor: { kind: "approval", userId: req.approverId },
      note: req.note,
    });
    return { state: to, approvals, required };
  });
}
