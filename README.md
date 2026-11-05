# Verified Payouts

Payout controls for businesses using the PayPal Payouts API. See [docs/SCOPE.md](docs/SCOPE.md).

## Local development

```bash
npm install
cp .env.example .env   # then fill in your sandbox credentials
npm run dev -- -H 127.0.0.1
npm test
```

Open http://127.0.0.1:3000/verify. Use `127.0.0.1`, not `localhost`, so the browser host matches the PayPal redirect URI.

## Environment variables

| Variable | Required | On Render | Description |
|---|---|---|---|
| `PAYPAL_CLIENT_ID` | Yes | Secret, set in dashboard | Client ID of your PayPal REST app |
| `PAYPAL_CLIENT_SECRET` | Yes | Secret, set in dashboard | Secret of your PayPal REST app |
| `PAYPAL_REDIRECT_URI` | In production | Secret, set in dashboard | Log in with PayPal return URL. Defaults to `http://127.0.0.1:3000/api/auth/paypal/callback` |
| `PAYPAL_ENVIRONMENT` | Yes | `SANDBOX` in `render.yaml` | `SANDBOX` or `LIVE` |

`render.yaml` declares the three secrets with `sync: false` and no value, so they exist only in Render. Never commit real values. `.env.example` lists the names only.

## Deploy on Render

`render.yaml` defines a Node web service on Render's free plan:

- Build: `npm ci && npm run build`
- Start: `npm start` (Next.js listens on Render's `PORT`)
- Health check: `GET /api/health` returns `200 {"status":"ok"}`

To deploy:

1. In Render, create a **Blueprint** from this repository.
2. When prompted, enter `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_REDIRECT_URI`. These are marked `sync: false`, so they are stored only in Render. `PAYPAL_ENVIRONMENT` is set to `SANDBOX` in `render.yaml`.
3. Set `PAYPAL_REDIRECT_URI` to `https://<your-service>.onrender.com/api/auth/paypal/callback`.
4. In the PayPal developer dashboard, add that exact URL as a return URL for Log in with PayPal on the app.
