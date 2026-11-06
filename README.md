# Verified Payouts

Payout controls for businesses using the PayPal Payouts API. See [docs/SCOPE.md](docs/SCOPE.md).

## Local development

```bash
npm install
cp .env.example .env   # then fill in your sandbox credentials
createdb verified_payouts
export DATABASE_URL=postgresql://localhost:5432/verified_payouts
npm run db:migrate
npm run db:seed        # optional sample data
npm run dev -- -H 127.0.0.1
npm test
```

The app reads `DATABASE_URL` from `.env` (Next.js loads it). `db:migrate` and `db:seed` do not load `.env`; they use only the shell environment, so a production URL in `.env` can't receive sample data by accident:

```bash
DATABASE_URL=postgresql://localhost:5432/verified_payouts npm run db:seed
```

Open http://127.0.0.1:3000/verify. Use `127.0.0.1`, not `localhost`, so the browser host matches the PayPal redirect URI.

## Environment variables

| Variable | Required | On Render | Description |
|---|---|---|---|
| `PAYPAL_CLIENT_ID` | Yes | Secret, set in dashboard | Client ID of your PayPal REST app |
| `PAYPAL_CLIENT_SECRET` | Yes | Secret, set in dashboard | Secret of your PayPal REST app |
| `PAYPAL_REDIRECT_URI` | In production | Secret, set in dashboard | Log in with PayPal return URL. Defaults to `http://127.0.0.1:3000/api/auth/paypal/callback` |
| `PAYPAL_ENVIRONMENT` | Yes | `SANDBOX` in `render.yaml` | `SANDBOX` or `LIVE` |
| `DATABASE_URL` | Yes | Secret, set in dashboard | Postgres connection string |
| `TEST_DATABASE_URL` | For database tests | Not used | A separate, migrated Postgres database for `npm test` |
| `CHECK_FIRST_PAYMENT_LIMIT_CENTS` | No | Optional | First payment above this is held for a second approver. Default `30000` ($300) |
| `CHECK_MEDIAN_MULTIPLIER_PERCENT` | No | Optional | Hold amounts above this % of the payee's median. Default `300` (3x), minimum `100` |
| `CHECK_MEDIAN_MIN_HISTORY` | No | Optional | Completed payments needed before the median rule applies. Default `3` |
| `CHECK_DUPLICATE_WINDOW_DAYS` | No | Optional | Same payee and amount within this many days is a duplicate. Default `3`; `0` checks the batch only |

`render.yaml` declares the four secrets with `sync: false` and no value, so they exist only in Render. Never commit real values. `.env.example` lists the names, with a local default where one is not secret.

## Database

Postgres 15 or later (the audit log uses `UNIQUE NULLS NOT DISTINCT`). Migrations are plain SQL in `migrations/`, run with [node-pg-migrate](https://salsita.github.io/node-pg-migrate/):

```bash
npm run db:migrate           # apply pending migrations
npm run db:migrate:down      # roll back the latest one
npx node-pg-migrate create <name> -m migrations -j sql
```

Money is stored as integer cents (`bigint`), USD only. `audit_entries` is append-only: triggers reject `UPDATE`, `DELETE` and `TRUNCATE`. Each entry stores the previous entry's SHA-256 hash, and the database rejects any entry that doesn't follow the latest one, so the log cannot fork. `verifyAuditLog` in `src/lib/audit/log.ts` recomputes the whole chain.

Database tests run only when `TEST_DATABASE_URL` is set. Each test runs in a transaction that is rolled back, but use a separate database anyway:

```bash
createdb verified_payouts_test
DATABASE_URL=postgresql://localhost:5432/verified_payouts_test npm run db:migrate
TEST_DATABASE_URL=postgresql://localhost:5432/verified_payouts_test npm test
```

## Payout items

`src/lib/payouts/state-machine.ts` holds every allowed state transition and who may make it. Illegal transitions throw, and every transition writes an audit entry in the same transaction. A database trigger rejects state or hold changes made any other way. Approval goes through `approvePayoutItem`. It needs an approver who did not invite or change the payee, and two different approvers when a hold requires a second approver.

The rule checks from the Checks table are pure functions in `src/lib/checks/rules.ts`. Limits come from the `CHECK_*` variables above. `loadCheckConfig` throws on an invalid value instead of silently loosening a check.

## Deploy on Render

`render.yaml` defines a Node web service on Render's free plan:

- Build: `npm ci && npm run build`
- Start: `npm run db:migrate && npm start`. Migrations run on every deploy before the server starts (Render's pre-deploy command is paid-only). Next.js listens on Render's `PORT`.
- Health check: `GET /api/health` returns `200 {"status":"ok"}`

To deploy:

1. In Render, create a **Blueprint** from this repository.
2. When prompted, enter `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_REDIRECT_URI` and `DATABASE_URL`. For a Render Postgres database in the same region, use its **Internal Database URL**. These are marked `sync: false`, so they are stored only in Render. `PAYPAL_ENVIRONMENT` is set to `SANDBOX` in `render.yaml`.
3. Set `PAYPAL_REDIRECT_URI` to `https://<your-service>.onrender.com/api/auth/paypal/callback`.
4. In the PayPal developer dashboard, add that exact URL as a return URL for Log in with PayPal on the app.
