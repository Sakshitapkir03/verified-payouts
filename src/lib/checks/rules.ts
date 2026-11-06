import type { HoldReason } from "../payouts/holds";
import type { PayoutItemState } from "../payouts/state-machine";
import type { CheckConfig } from "./config";

/**
 * Rule checks from the Checks table in docs/SCOPE.md. Every function is pure:
 * callers load the item, the payee's history and the rest of the batch, and
 * get back the reasons to hold or block. The AI document-name check is
 * separate and not here.
 */

export type CheckItem = {
  lineNumber: number;
  payeeId: string;
  amountCents: number;
  /** The receiver given in the uploaded batch, if any. Payouts always go to the verified account. */
  receiver: { type: "paypal_id" | "email"; value: string } | null;
};

export type ActiveVerification = {
  payerId: string;
  verifiedAccount: boolean;
  verifiedName: string | null;
  email: string | null;
};

export type HistoryItem = {
  amountCents: number;
  state: PayoutItemState;
  createdAt: Date;
};

export type CheckContext = {
  payee: { id: string };
  verification: ActiveVerification | null;
  /** The payee's items from earlier batches. */
  history: readonly HistoryItem[];
  /** Every line in this batch, including the item being checked. */
  batch: readonly { lineNumber: number; payeeId: string; amountCents: number }[];
  /** Other payees whose active verification is the same PayPal account. */
  sharedAccountPayeeIds: readonly string[];
  staff: readonly { name: string; email: string }[];
  now: Date;
};

export type Rule = (item: CheckItem, ctx: CheckContext, config: CheckConfig) => HoldReason | null;

const DAY_MS = 24 * 60 * 60 * 1000;

// Items in these states never paid anyone, so they don't count as earlier payments.
const NOT_PAID: ReadonlySet<PayoutItemState> = new Set(["cancelled", "failed", "returned", "blocked"]);

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function reason(
  code: string,
  action: "hold" | "block",
  explanation: string,
  requiresSecondApprover = false,
): HoldReason {
  return { code, action, source: "rule", explanation, requiresSecondApprover };
}

/** Case, width, spacing and punctuation-insensitive form for name matching. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{P}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Block: the payee has no active Log in with PayPal verification. */
export const payeeNotVerified: Rule = (_item, ctx) => {
  if (ctx.verification) return null;
  return reason("payee_not_verified", "block", "Payee has not verified a PayPal account.");
};

/**
 * Hold: the payee proved control of the account with Log in with PayPal,
 * but PayPal's own verified flag on the account is false.
 */
export const paypalAccountUnverified: Rule = (_item, ctx) => {
  if (!ctx.verification || ctx.verification.verifiedAccount) return null;
  return reason(
    "paypal_account_unverified",
    "hold",
    "The payee logged in with this PayPal account, but PayPal marks the account itself as unverified. Confirm the payee before approving.",
  );
};

/** Block: the batch names a receiver other than the verified account. */
export const accountDiffersFromVerified: Rule = (item, ctx) => {
  const v = ctx.verification;
  if (!v || !item.receiver) return null;
  const value = item.receiver.value.trim();
  const matches =
    item.receiver.type === "paypal_id"
      ? value.toUpperCase() === v.payerId.toUpperCase()
      : v.email !== null && normalizeEmail(value) === normalizeEmail(v.email);
  if (matches) return null;
  return reason(
    "account_differs_from_verified",
    "block",
    `Line ${item.lineNumber} names a different PayPal account from the one the payee verified.`,
  );
};

/**
 * Hold: same payee and amount on another line of this batch, or on an
 * earlier item within the duplicate window. Lines in the same batch are
 * always flagged; the window only applies to earlier batches.
 */
export const duplicateLine: Rule = (item, ctx, config) => {
  const lines = ctx.batch
    .filter(
      (l) =>
        l.lineNumber !== item.lineNumber &&
        l.payeeId === item.payeeId &&
        l.amountCents === item.amountCents,
    )
    .map((l) => l.lineNumber)
    .sort((a, b) => a - b);
  const since = ctx.now.getTime() - config.duplicateWindowDays * DAY_MS;
  const recent =
    config.duplicateWindowDays > 0 &&
    ctx.history.some(
      (h) =>
        h.amountCents === item.amountCents &&
        !NOT_PAID.has(h.state) &&
        h.createdAt.getTime() >= since,
    );
  if (lines.length === 0 && !recent) return null;
  const parts: string[] = [];
  if (lines.length) {
    parts.push(`${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")} of this batch`);
  }
  if (recent) {
    parts.push(`a payment in the last ${config.duplicateWindowDays} ${config.duplicateWindowDays === 1 ? "day" : "days"}`);
  }
  return reason(
    "duplicate_line",
    "hold",
    `Same payee and amount (${formatCents(item.amountCents)}) as ${parts.join(" and ")}.`,
  );
};

/**
 * Hold with second approver: the payee has no completed payment yet and
 * their total in this batch is over the limit. The total, not the line, so
 * splitting a payment across lines doesn't avoid the check.
 */
export const firstPaymentOverLimit: Rule = (item, ctx, config) => {
  if (ctx.history.some((h) => h.state === "completed")) return null;
  const lines = ctx.batch.filter((l) => l.payeeId === item.payeeId);
  const includesItem = lines.some((l) => l.lineNumber === item.lineNumber);
  const total =
    lines.reduce((sum, l) => sum + l.amountCents, 0) + (includesItem ? 0 : item.amountCents);
  if (total <= config.firstPaymentLimitCents) return null;
  const split = lines.length > 1 ? ` across ${lines.length} lines` : "";
  return reason(
    "first_payment_over_limit",
    "hold",
    `First payment to this payee totals ${formatCents(total)}${split}, over the ${formatCents(config.firstPaymentLimitCents)} limit. Needs a second approver.`,
    true,
  );
};

/** Hold: the amount is over the configured multiple of the payee's median completed payment. */
export const amountOverMedian: Rule = (item, ctx, config) => {
  const amounts = ctx.history
    .filter((h) => h.state === "completed")
    .map((h) => h.amountCents)
    .sort((a, b) => a - b);
  if (amounts.length < config.medianMinHistory) return null;
  const mid = Math.floor(amounts.length / 2);
  // Twice the median, so even-length medians stay in integer cents.
  const twiceMedian =
    amounts.length % 2 === 1 ? BigInt(2) * BigInt(amounts[mid]) : BigInt(amounts[mid - 1]) + BigInt(amounts[mid]);
  // amount > (percent / 100) * median, in integers.
  if (BigInt(item.amountCents) * BigInt(200) <= BigInt(config.medianMultiplierPercent) * twiceMedian) {
    return null;
  }
  const median = Number(twiceMedian) / 2;
  return reason(
    "amount_over_median",
    "hold",
    `${formatCents(item.amountCents)} is more than ${config.medianMultiplierPercent / 100}x this payee's median payment of ${formatCents(Math.round(median))}.`,
  );
};

/** Hold: the verified PayPal account is also verified for another payee. */
export const sharedAccount: Rule = (_item, ctx) => {
  if (!ctx.verification) return null;
  const others = ctx.sharedAccountPayeeIds.filter((id) => id !== ctx.payee.id);
  if (others.length === 0) return null;
  return reason(
    "shared_account",
    "hold",
    `The verified PayPal account is also verified for ${others.length} other ${others.length === 1 ? "payee" : "payees"}.`,
  );
};

/** Hold: the verified name or email matches a staff member. */
export const matchesStaff: Rule = (_item, ctx) => {
  const v = ctx.verification;
  if (!v) return null;
  const name = v.verifiedName ? normalizeName(v.verifiedName) : null;
  const email = v.email ? normalizeEmail(v.email) : null;
  const match = ctx.staff.find(
    (s) =>
      (name !== null && name !== "" && normalizeName(s.name) === name) ||
      (email !== null && normalizeEmail(s.email) === email),
  );
  if (!match) return null;
  return reason(
    "matches_staff_member",
    "hold",
    `The verified PayPal identity matches staff member ${match.name}.`,
  );
};

/** In the order reasons are reported: blocks first, then holds. */
export const RULES: readonly Rule[] = [
  payeeNotVerified,
  accountDiffersFromVerified,
  paypalAccountUnverified,
  duplicateLine,
  firstPaymentOverLimit,
  amountOverMedian,
  sharedAccount,
  matchesStaff,
];

export type CheckResult = {
  outcome: "ready" | "held" | "blocked";
  reasons: HoldReason[];
};

export function runChecks(item: CheckItem, ctx: CheckContext, config: CheckConfig): CheckResult {
  if (!Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) {
    throw new Error("amountCents must be a positive whole number of cents");
  }
  const reasons = RULES.map((rule) => rule(item, ctx, config)).filter(
    (r): r is HoldReason => r !== null,
  );
  const outcome = reasons.some((r) => r.action === "block")
    ? "blocked"
    : reasons.length > 0
      ? "held"
      : "ready";
  return { outcome, reasons };
}
