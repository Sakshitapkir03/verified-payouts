# Verified Payouts

Payout controls for businesses using the PayPal Payouts API. Payouts go only to PayPal accounts the payee has verified, account changes require proof of continuity, and every batch is checked before it is sent.

## Problem

Payout diversion: an attacker impersonates a payee ("new PayPal email, pay me here"), an insider adds a fake payee, or amounts are altered. Claimed payouts are hard to recover. Business email compromise caused $3.05B in reported US losses in 2025 (FBI IC3); figures specific to PayPal payouts are not public, so the extent on this channel is an assumption to validate with customers.

## Customers

Businesses paying 20+ people through the standard PayPal Payouts API: creator and affiliate programs, freelance marketplaces, agencies, research panels.

## Positioning

PayPal's enterprise payout platform (Hyperwallet) includes payee verification, KYC/AML screening and tax reporting. Businesses on the standard Payouts API do not get that layer. Verified Payouts adds payout controls for them without a platform migration. Businesses needing full identity and tax compliance should use Hyperwallet.

## Roles

- **Operator:** invites payees, uploads batches
- **Approver:** reviews holds and approves; cannot approve payees they invited or changed
- **Payee:** verifies once with Log in with PayPal; uses the portal for any account change

## Flow

1. Operator invites payee and attaches an invoice or contract.
2. Payee logs in with PayPal → account ID, verified status, name and email stored.
3. AI finds the payee's name in the document and checks it against the verified name.
4. Operator uploads batch → checks run → items ready or held with a reason.
5. Approver approves → Payouts API sends to verified account IDs.
6. Webhooks and status sync update each item; every action is audited.

## Account changes

Changes are only made through the payee portal, never from a message.

- **Payee can access the old account:** logs in with the old account, then the new one. Change applies after approval.
- **Payee lost access:** 72-hour cooling-off period, notice sent to the old PayPal email and contact email, approver confirms by phone using contact details on file, first payout to the new account capped.

## Checks

| Check | Source | Action |
|---|---|---|
| Payee not verified | Rule | Block |
| PayPal marks the verified account as unverified | Rule | Hold |
| Account differs from verified | Rule | Block |
| Duplicate line | Rule | Hold |
| First payment > $300 | Rule | Hold, second approver |
| Amount > 3x payee median | Rule | Hold |
| Two payees, one account | Rule | Hold |
| Verified identity matches a staff member | Rule | Hold |
| Name in document doesn't match verified name | AI | Hold |

Limits are configurable.

## Role of AI

Reads onboarding documents (invoices, contracts) to find the payee's name and match it to the PayPal-verified name, where string matching fails: "Bob Smith" vs "Robert J. Smith", "Studio Kōhaku LLC" listing owner Haruto Tanaka, Cyrillic vs Latin spellings. Also reviews the reason and documents a payee gives for an account change, and writes the explanation for every hold.

AI only flags and explains; it never approves or sends. If unavailable, items needing AI checks are held.

## Rollout for existing payees

1. Import existing payees.
2. Invite them to verify (one login, about a minute) by a deadline.
3. Items for payees who have not verified are blocked.

## PayPal APIs

- Identity (Log in with PayPal): account ID, verified status, email, name
- Payouts: create batch, batch/item status, cancel unclaimed item
- Webhooks: payout item events, signature verification

## Payout item states

`draft → held | ready → approved → sent → completed | unclaimed | returned | failed | blocked | cancelled`

Holds can be added to a held item but never removed; a held item is cleared only by approval. Adding a hold voids earlier approvals, so approvers see every reason before an item is approved.

## Batch statuses

`draft → checked → sent → closed`

- **draft:** uploaded; every item is draft and nothing has been checked.
- **checked:** the rule checks ran once over the whole batch; each item is ready, held or blocked. Approvers review and approve here. Later rechecks of single items go through the item states, not the batch.
- **sent:** the executor submitted the approved items to the Payouts API under the batch's idempotent ID. Held, blocked and cancelled items are not sent.
- **closed:** every sent item has a final result (completed, returned, failed or cancelled); nothing in the batch will change.

## Guarantees

- No duplicate sends (idempotent batch IDs)
- No unverified or unapproved item is sent
- Webhooks are signature-verified; missed events caught by status sync
- Audit log is append-only

## Data handling

Stored: PayPal account ID, verified flag, verified name, email, verification time. Access tokens are discarded after the profile is fetched. Payees consent on the PayPal login screen. Data is deleted on request or when a payee is removed.

## Success measures

- Under 5% of items held in a steady-state batch
- Under 20% of holds released as false alarms
- Holds resolved within 1 business day

## Limitations

- Verification proves control of a PayPal account, not that the payee did the work.
- Two colluding insiders (inviter and approver) can bypass controls.
- Payees need a PayPal account.

## Launch prerequisites

- Live Payouts enabled on the business's PayPal account
- Use of Log in with PayPal for payee verification confirmed with PayPal

## Stack

Next.js, TypeScript, Postgres, Zod. AI provider behind an interface. Hosted on Render.

## Not in v1

SSO and team management, inbox integrations, bank payouts, tax forms, multi-tenant billing.

## Roadmap

- **Monitor mode** for existing payees: imported payees are paid as before while checks run and only report, so a business can see what would be held before enforcing. Unverified payees are held after their verification deadline.
