export type ApproverCheck =
  | { ok: true }
  | { ok: false; reason: "not_an_approver" | "invited_payee" | "changed_payee" };

/**
 * Separation of duties: only approvers approve, and never for a payee they
 * invited or changed. `changedBy` is every user recorded as having changed
 * the payee, not only the most recent one.
 */
export function checkApprover(input: {
  approverId: string;
  approverRole: "operator" | "approver";
  invitedBy: string;
  changedBy: readonly (string | null)[];
}): ApproverCheck {
  if (input.approverRole !== "approver") {
    return { ok: false, reason: "not_an_approver" };
  }
  const me = input.approverId.toLowerCase();
  if (input.invitedBy.toLowerCase() === me) {
    return { ok: false, reason: "invited_payee" };
  }
  if (input.changedBy.some((id) => id?.toLowerCase() === me)) {
    return { ok: false, reason: "changed_payee" };
  }
  return { ok: true };
}
