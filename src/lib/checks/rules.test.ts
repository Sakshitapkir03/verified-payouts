import { describe, expect, it } from "vitest";
import { DEFAULT_CHECK_CONFIG, type CheckConfig } from "./config";
import {
  accountDiffersFromVerified,
  amountOverMedian,
  duplicateLine,
  firstPaymentOverLimit,
  formatCents,
  matchesStaff,
  normalizeName,
  payeeNotVerified,
  runChecks,
  sharedAccount,
  type CheckContext,
  type CheckItem,
  type HistoryItem,
} from "./rules";

const NOW = new Date("2026-11-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const PAYEE = "payee-1";
const config: CheckConfig = { ...DEFAULT_CHECK_CONFIG };

function item(overrides: Partial<CheckItem> = {}): CheckItem {
  return { lineNumber: 1, payeeId: PAYEE, amountCents: 10000, receiver: null, ...overrides };
}

function completed(amountCents: number, daysAgo = 30): HistoryItem {
  return { amountCents, state: "completed", createdAt: new Date(NOW.getTime() - daysAgo * DAY) };
}

/** A verified payee with a normal payment history and a one-line batch. */
function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    payee: { id: PAYEE },
    verification: {
      payerId: "PAYERID12345",
      verifiedAccount: true,
      verifiedName: "Robert J. Smith",
      email: "robert@example.com",
    },
    history: [completed(10000, 40), completed(12000, 30), completed(11000, 20)],
    batch: [{ lineNumber: 1, payeeId: PAYEE, amountCents: 10000 }],
    sharedAccountPayeeIds: [],
    staff: [{ name: "Olivia Operator", email: "olivia@company.example" }],
    now: NOW,
    ...overrides,
  };
}

describe("formatCents", () => {
  it.each([
    [0, "$0.00"],
    [5, "$0.05"],
    [100, "$1.00"],
    [30000, "$300.00"],
    [123456789, "$1,234,567.89"],
  ])("formats %i as %s", (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});

describe("normalizeName", () => {
  it("ignores case, punctuation and extra spaces", () => {
    expect(normalizeName("  Robert  J. SMITH ")).toBe("robert j smith");
  });

  it("folds full-width characters", () => {
    expect(normalizeName("Ｒｏｂｅｒｔ")).toBe("robert");
  });

  it("keeps non-Latin scripts", () => {
    expect(normalizeName("Анна Петрова")).toBe("анна петрова");
  });
});

describe("payeeNotVerified", () => {
  it("passes a verified payee", () => {
    expect(payeeNotVerified(item(), ctx(), config)).toBeNull();
  });

  it("blocks a payee with no verification", () => {
    expect(payeeNotVerified(item(), ctx({ verification: null }), config)).toMatchObject({
      code: "payee_not_verified",
      action: "block",
      source: "rule",
      requiresSecondApprover: false,
      explanation: "Payee has not verified a PayPal account.",
    });
  });

  it("blocks when PayPal reports the account as unverified", () => {
    const c = ctx();
    c.verification = { ...c.verification!, verifiedAccount: false };
    expect(payeeNotVerified(item(), c, config)).toMatchObject({
      action: "block",
      explanation: "PayPal reports the payee's account as not verified.",
    });
  });
});

describe("accountDiffersFromVerified", () => {
  it("passes when the batch names no receiver", () => {
    expect(accountDiffersFromVerified(item(), ctx(), config)).toBeNull();
  });

  it("passes a matching PayPal ID, ignoring case and whitespace", () => {
    const i = item({ receiver: { type: "paypal_id", value: " payerid12345 " } });
    expect(accountDiffersFromVerified(i, ctx(), config)).toBeNull();
  });

  it("blocks a different PayPal ID", () => {
    const i = item({ lineNumber: 7, receiver: { type: "paypal_id", value: "OTHERPAYER99" } });
    expect(accountDiffersFromVerified(i, ctx(), config)).toMatchObject({
      code: "account_differs_from_verified",
      action: "block",
      explanation: "Line 7 names a different PayPal account from the one the payee verified.",
    });
  });

  it("passes a matching email, ignoring case", () => {
    const i = item({ receiver: { type: "email", value: "Robert@Example.com" } });
    expect(accountDiffersFromVerified(i, ctx(), config)).toBeNull();
  });

  it("blocks a different email", () => {
    const i = item({ receiver: { type: "email", value: "new-paypal@attacker.example" } });
    expect(accountDiffersFromVerified(i, ctx(), config)).toMatchObject({ action: "block" });
  });

  it("blocks an email receiver when the verification has no email", () => {
    const c = ctx();
    c.verification = { ...c.verification!, email: null };
    const i = item({ receiver: { type: "email", value: "robert@example.com" } });
    expect(accountDiffersFromVerified(i, c, config)).toMatchObject({ action: "block" });
  });

  it("does not compare an email against the PayPal ID", () => {
    const i = item({ receiver: { type: "email", value: "PAYERID12345" } });
    expect(accountDiffersFromVerified(i, ctx(), config)).toMatchObject({ action: "block" });
  });

  it("leaves unverified payees to the not-verified rule", () => {
    const i = item({ receiver: { type: "paypal_id", value: "ANY" } });
    expect(accountDiffersFromVerified(i, ctx({ verification: null }), config)).toBeNull();
  });
});

describe("duplicateLine", () => {
  const batch = (...lines: [number, string, number][]) =>
    lines.map(([lineNumber, payeeId, amountCents]) => ({ lineNumber, payeeId, amountCents }));

  it("passes a unique line", () => {
    expect(duplicateLine(item(), ctx(), config)).toBeNull();
  });

  it("holds the same payee and amount on another line", () => {
    const c = ctx({ batch: batch([1, PAYEE, 10000], [4, PAYEE, 10000]) });
    expect(duplicateLine(item(), c, config)).toMatchObject({
      code: "duplicate_line",
      action: "hold",
      requiresSecondApprover: false,
      explanation: "Same payee and amount ($100.00) as line 4 of this batch.",
    });
  });

  it("holds every line of a duplicate group, listing the others in order", () => {
    const c = ctx({ batch: batch([9, PAYEE, 10000], [1, PAYEE, 10000], [4, PAYEE, 10000]) });
    expect(duplicateLine(item({ lineNumber: 4 }), c, config)?.explanation).toBe(
      "Same payee and amount ($100.00) as lines 1, 9 of this batch.",
    );
  });

  it("does not count the item's own line", () => {
    const c = ctx({ batch: batch([1, PAYEE, 10000]) });
    expect(duplicateLine(item(), c, config)).toBeNull();
  });

  it("ignores the same amount for a different payee", () => {
    const c = ctx({ batch: batch([1, PAYEE, 10000], [2, "payee-2", 10000]) });
    expect(duplicateLine(item(), c, config)).toBeNull();
  });

  it("ignores a different amount for the same payee", () => {
    const c = ctx({ batch: batch([1, PAYEE, 10000], [2, PAYEE, 10001]) });
    expect(duplicateLine(item(), c, config)).toBeNull();
  });

  it("holds a matching payment within the window", () => {
    const c = ctx({ history: [completed(10000, 1)] });
    expect(duplicateLine(item(), c, config)?.explanation).toBe(
      "Same payee and amount ($100.00) as a payment in the last 3 days.",
    );
  });

  it("includes a payment exactly at the window edge", () => {
    const c = ctx({ history: [completed(10000, 3)] });
    expect(duplicateLine(item(), c, config)).not.toBeNull();
  });

  it("ignores a payment just outside the window", () => {
    const c = ctx({ history: [{ ...completed(10000), createdAt: new Date(NOW.getTime() - 3 * DAY - 1) }] });
    expect(duplicateLine(item(), c, config)).toBeNull();
  });

  it.each(["cancelled", "failed", "returned", "blocked"] as const)(
    "ignores a recent %s item",
    (state) => {
      const c = ctx({ history: [{ amountCents: 10000, state, createdAt: NOW }] });
      expect(duplicateLine(item(), c, config)).toBeNull();
    },
  );

  it.each(["draft", "held", "ready", "approved", "sent", "unclaimed", "completed"] as const)(
    "counts a recent %s item",
    (state) => {
      const c = ctx({ history: [{ amountCents: 10000, state, createdAt: NOW }] });
      expect(duplicateLine(item(), c, config)).not.toBeNull();
    },
  );

  it("checks only this batch when the window is 0", () => {
    const c = ctx({ history: [completed(10000, 0)] });
    expect(duplicateLine(item(), c, { ...config, duplicateWindowDays: 0 })).toBeNull();
    const dup = ctx({ batch: batch([1, PAYEE, 10000], [2, PAYEE, 10000]) });
    expect(duplicateLine(item(), dup, { ...config, duplicateWindowDays: 0 })).not.toBeNull();
  });

  it("uses singular wording for a 1-day window", () => {
    const c = ctx({ history: [completed(10000, 0)] });
    expect(duplicateLine(item(), c, { ...config, duplicateWindowDays: 1 })?.explanation).toBe(
      "Same payee and amount ($100.00) as a payment in the last 1 day.",
    );
  });

  it("reports both a batch duplicate and a recent payment", () => {
    const c = ctx({
      batch: batch([1, PAYEE, 10000], [2, PAYEE, 10000]),
      history: [completed(10000, 1)],
    });
    expect(duplicateLine(item(), c, config)?.explanation).toBe(
      "Same payee and amount ($100.00) as line 2 of this batch and a payment in the last 3 days.",
    );
  });
});

describe("firstPaymentOverLimit", () => {
  const first = (amountCents: number, more: Partial<CheckContext> = {}) =>
    firstPaymentOverLimit(
      item({ amountCents }),
      ctx({ history: [], batch: [{ lineNumber: 1, payeeId: PAYEE, amountCents }], ...more }),
      config,
    );

  it("holds a first payment over $300 and needs a second approver", () => {
    expect(first(30001)).toEqual({
      code: "first_payment_over_limit",
      action: "hold",
      source: "rule",
      requiresSecondApprover: true,
      explanation: "First payment to this payee totals $300.01, over the $300.00 limit. Needs a second approver.",
    });
  });

  it("passes a first payment of exactly $300", () => {
    expect(first(30000)).toBeNull();
  });

  it("passes a small first payment", () => {
    expect(first(100)).toBeNull();
  });

  it("passes once the payee has a completed payment", () => {
    expect(first(100000, { history: [completed(100)] })).toBeNull();
  });

  it.each(["sent", "unclaimed", "returned", "failed", "cancelled"] as const)(
    "still treats a payee whose only earlier item is %s as first",
    (state) => {
      expect(first(30001, { history: [{ amountCents: 100, state, createdAt: NOW }] })).not.toBeNull();
    },
  );

  it("adds up the payee's lines so a split payment is still held", () => {
    const c = ctx({
      history: [],
      batch: [
        { lineNumber: 1, payeeId: PAYEE, amountCents: 20000 },
        { lineNumber: 2, payeeId: PAYEE, amountCents: 20000 },
      ],
    });
    expect(firstPaymentOverLimit(item({ amountCents: 20000 }), c, config)?.explanation).toBe(
      "First payment to this payee totals $400.00 across 2 lines, over the $300.00 limit. Needs a second approver.",
    );
  });

  it("does not count other payees' lines", () => {
    const c = ctx({
      history: [],
      batch: [
        { lineNumber: 1, payeeId: PAYEE, amountCents: 20000 },
        { lineNumber: 2, payeeId: "payee-2", amountCents: 20000 },
      ],
    });
    expect(firstPaymentOverLimit(item({ amountCents: 20000 }), c, config)).toBeNull();
  });

  it("counts the item even if it is missing from the batch list", () => {
    const c = ctx({ history: [], batch: [{ lineNumber: 2, payeeId: PAYEE, amountCents: 20000 }] });
    expect(firstPaymentOverLimit(item({ amountCents: 20000 }), c, config)).not.toBeNull();
  });

  it("uses the configured limit", () => {
    const c = ctx({ history: [], batch: [{ lineNumber: 1, payeeId: PAYEE, amountCents: 5001 }] });
    expect(
      firstPaymentOverLimit(item({ amountCents: 5001 }), c, { ...config, firstPaymentLimitCents: 5000 }),
    ).not.toBeNull();
    expect(
      firstPaymentOverLimit(item({ amountCents: 5001 }), c, { ...config, firstPaymentLimitCents: 0 }),
    ).not.toBeNull();
  });
});

describe("amountOverMedian", () => {
  const withHistory = (amounts: number[], amountCents: number, cfg: CheckConfig = config) =>
    amountOverMedian(item({ amountCents }), ctx({ history: amounts.map((a) => completed(a)) }), cfg);

  it("passes an amount at exactly 3x the median", () => {
    expect(withHistory([100, 200, 300], 600)).toBeNull();
  });

  it("holds one cent over 3x the median", () => {
    expect(withHistory([100, 200, 300], 601)).toMatchObject({
      code: "amount_over_median",
      action: "hold",
      requiresSecondApprover: false,
      explanation: "$6.01 is more than 3x this payee's median payment of $2.00.",
    });
  });

  it("uses the middle of an odd history, not the mean", () => {
    // Mean is 34000; median is 1000.
    expect(withHistory([1000, 1000, 100000], 3001)).not.toBeNull();
  });

  it("averages the two middle values of an even history", () => {
    // Median 150.5 cents; 3x is 451.5.
    expect(withHistory([100, 101, 200, 300], 451)).toBeNull();
    expect(withHistory([100, 101, 200, 300], 452)).not.toBeNull();
  });

  it("does not depend on history order", () => {
    expect(withHistory([300, 100, 200], 601)).not.toBeNull();
    expect(withHistory([300, 100, 200], 600)).toBeNull();
  });

  it("skips payees with fewer completed payments than the minimum", () => {
    expect(withHistory([100, 100], 100000)).toBeNull();
  });

  it("applies at exactly the minimum history", () => {
    expect(withHistory([100, 100, 100], 100000)).not.toBeNull();
  });

  it("counts only completed payments", () => {
    const history: HistoryItem[] = [
      completed(100),
      completed(100),
      { amountCents: 100, state: "sent", createdAt: NOW },
      { amountCents: 100, state: "returned", createdAt: NOW },
    ];
    expect(amountOverMedian(item({ amountCents: 100000 }), ctx({ history }), config)).toBeNull();
  });

  it("uses the configured multiplier and minimum history", () => {
    const cfg = { ...config, medianMultiplierPercent: 250, medianMinHistory: 1 };
    expect(withHistory([1000], 2500, cfg)).toBeNull();
    expect(withHistory([1000], 2501, cfg)?.explanation).toBe(
      "$25.01 is more than 2.5x this payee's median payment of $10.00.",
    );
  });

  it("handles large amounts without overflow", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(withHistory([big, big, big], big)).toBeNull();
  });
});

describe("sharedAccount", () => {
  it("passes an account no other payee uses", () => {
    expect(sharedAccount(item(), ctx(), config)).toBeNull();
  });

  it("ignores the payee's own id", () => {
    expect(sharedAccount(item(), ctx({ sharedAccountPayeeIds: [PAYEE] }), config)).toBeNull();
  });

  it("holds when another payee verified the same account", () => {
    expect(sharedAccount(item(), ctx({ sharedAccountPayeeIds: ["payee-2"] }), config)).toMatchObject({
      code: "shared_account",
      action: "hold",
      explanation: "The verified PayPal account is also verified for 1 other payee.",
    });
  });

  it("counts several other payees", () => {
    const c = ctx({ sharedAccountPayeeIds: ["payee-2", PAYEE, "payee-3"] });
    expect(sharedAccount(item(), c, config)?.explanation).toBe(
      "The verified PayPal account is also verified for 2 other payees.",
    );
  });

  it("does not apply without a verification", () => {
    const c = ctx({ verification: null, sharedAccountPayeeIds: ["payee-2"] });
    expect(sharedAccount(item(), c, config)).toBeNull();
  });
});

describe("matchesStaff", () => {
  const withVerified = (verifiedName: string | null, email: string | null, staff = ctx().staff) =>
    matchesStaff(
      item(),
      ctx({
        verification: { payerId: "P", verifiedAccount: true, verifiedName, email },
        staff,
      }),
      config,
    );

  it("passes when nothing matches", () => {
    expect(matchesStaff(item(), ctx(), config)).toBeNull();
  });

  it("holds a verified name matching a staff member", () => {
    expect(withVerified("Olivia Operator", "someone@example.com")).toMatchObject({
      code: "matches_staff_member",
      action: "hold",
      explanation: "The verified PayPal identity matches staff member Olivia Operator.",
    });
  });

  it("matches names regardless of case, punctuation and spacing", () => {
    expect(withVerified("  OLIVIA   operator.", null)).not.toBeNull();
  });

  it("holds a verified email matching a staff email, ignoring case", () => {
    expect(withVerified("Someone Else", " Olivia@Company.Example ")).not.toBeNull();
  });

  it("does not match a partial name", () => {
    expect(withVerified("Olivia", null)).toBeNull();
    expect(withVerified("Olivia Operator Jr", null)).toBeNull();
  });

  it("does not match an empty name to an empty staff name", () => {
    expect(withVerified("...", null, [{ name: "", email: "x@company.example" }])).toBeNull();
  });

  it("handles a verification with no name or email", () => {
    expect(withVerified(null, null)).toBeNull();
  });

  it("does not apply without a verification", () => {
    expect(matchesStaff(item(), ctx({ verification: null }), config)).toBeNull();
  });
});

describe("runChecks", () => {
  it("returns ready with no reasons for a clean item", () => {
    expect(runChecks(item(), ctx(), config)).toEqual({ outcome: "ready", reasons: [] });
  });

  it("returns held when only holds apply", () => {
    const result = runChecks(item(), ctx({ sharedAccountPayeeIds: ["payee-2"] }), config);
    expect(result.outcome).toBe("held");
    expect(result.reasons.map((r) => r.code)).toEqual(["shared_account"]);
  });

  it("returns blocked when any block applies, with every reason, blocks first", () => {
    const result = runChecks(
      item({ amountCents: 50000 }),
      ctx({ verification: null, history: [], batch: [{ lineNumber: 1, payeeId: PAYEE, amountCents: 50000 }] }),
      config,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toEqual(["payee_not_verified", "first_payment_over_limit"]);
  });

  it("collects several holds", () => {
    const result = runChecks(
      item({ amountCents: 40000 }),
      ctx({
        history: [completed(10000), completed(10000), completed(10000)],
        batch: [
          { lineNumber: 1, payeeId: PAYEE, amountCents: 40000 },
          { lineNumber: 2, payeeId: PAYEE, amountCents: 40000 },
        ],
        sharedAccountPayeeIds: ["payee-2"],
      }),
      config,
    );
    expect(result.reasons.map((r) => r.code)).toEqual([
      "duplicate_line",
      "amount_over_median",
      "shared_account",
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an amount of %s cents",
    (amountCents) => {
      expect(() => runChecks(item({ amountCents }), ctx(), config)).toThrow(/positive whole number/);
    },
  );

  it("returns reasons the state machine accepts", async () => {
    const { HoldReasonsSchema } = await import("../payouts/holds");
    const result = runChecks(
      item({ amountCents: 50000, receiver: { type: "paypal_id", value: "OTHER" } }),
      ctx({ history: [], batch: [{ lineNumber: 1, payeeId: PAYEE, amountCents: 50000 }] }),
      config,
    );
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(HoldReasonsSchema.safeParse(result.reasons).success).toBe(true);
  });
});
