import { describe, expect, it } from "vitest";
import { checkApprover } from "./approval-rules";
import { requiredApprovals, type HoldReason } from "./holds";

const APPROVER = "aaaaaaaa-0000-4000-8000-000000000001";
const OPERATOR = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER = "cccccccc-0000-4000-8000-000000000003";

describe("checkApprover", () => {
  const base = {
    approverId: APPROVER,
    approverRole: "approver" as const,
    invitedBy: OPERATOR,
    changedBy: [],
  };

  it("allows an approver who neither invited nor changed the payee", () => {
    expect(checkApprover(base)).toEqual({ ok: true });
  });

  it("allows when others changed the payee", () => {
    expect(checkApprover({ ...base, changedBy: [OPERATOR, OTHER, null] })).toEqual({ ok: true });
  });

  it("rejects an operator", () => {
    expect(checkApprover({ ...base, approverRole: "operator" })).toEqual({
      ok: false,
      reason: "not_an_approver",
    });
  });

  it("rejects the approver who invited the payee", () => {
    expect(checkApprover({ ...base, invitedBy: APPROVER })).toEqual({
      ok: false,
      reason: "invited_payee",
    });
  });

  it("rejects an approver who changed the payee, even if not the latest editor", () => {
    expect(checkApprover({ ...base, changedBy: [APPROVER, OTHER] })).toEqual({
      ok: false,
      reason: "changed_payee",
    });
    expect(checkApprover({ ...base, changedBy: [OTHER, APPROVER] })).toEqual({
      ok: false,
      reason: "changed_payee",
    });
  });

  it("compares ids case-insensitively", () => {
    expect(checkApprover({ ...base, invitedBy: APPROVER.toUpperCase() })).toMatchObject({
      reason: "invited_payee",
    });
    expect(checkApprover({ ...base, approverId: APPROVER.toUpperCase(), changedBy: [APPROVER] }))
      .toMatchObject({ reason: "changed_payee" });
  });

  it("checks the role before anything else", () => {
    expect(
      checkApprover({ ...base, approverRole: "operator", invitedBy: APPROVER }),
    ).toMatchObject({ reason: "not_an_approver" });
  });
});

describe("requiredApprovals", () => {
  const hold = (requiresSecondApprover: boolean): HoldReason => ({
    code: "x",
    action: "hold",
    source: "rule",
    explanation: "x",
    requiresSecondApprover,
  });

  it("needs one approval with no holds", () => {
    expect(requiredApprovals([])).toBe(1);
  });

  it("needs one approval for ordinary holds", () => {
    expect(requiredApprovals([hold(false), hold(false)])).toBe(1);
  });

  it("needs two approvals if any hold requires a second approver", () => {
    expect(requiredApprovals([hold(false), hold(true)])).toBe(2);
  });
});
