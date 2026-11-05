# Verified Payouts — rules for this repo

Read docs/SCOPE.md before making changes.

- Never read or print .env. Use .env.example for variable names.
- Money: integer cents only, never floats. USD only in v1.
- Only src/lib/paypal/ may call PayPal. Only the executor may send payouts.
- AI output must be validated with Zod. AI may only add holds, never remove or approve.
- Enforce all permissions server-side.
- Payout item state changes go through the state machine only.
- Every new rule or state transition needs a unit test.
- Small commits with clear messages.
