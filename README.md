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

| Variable | Required | Secret | Description |
|---|---|---|---|
| `PAYPAL_CLIENT_ID` | Yes | No* | Client ID of your PayPal REST app |
| `PAYPAL_CLIENT_SECRET` | Yes | **Yes** | Secret of your PayPal REST app |
| `PAYPAL_ENVIRONMENT` | Yes | No | `SANDBOX` or `LIVE` |
| `PAYPAL_REDIRECT_URI` | In production | No | Log in with PayPal return URL. Defaults to `http://127.0.0.1:3000/api/auth/paypal/callback` |

\* Not secret, but tied to your PayPal app, so it is set per environment rather than committed.

Never commit real values. `.env.example` lists the names only.

## Deploy on Render

`render.yaml` defines a Node web service:

- Build: `npm ci && npm run build`
- Start: `npm start` (Next.js listens on Render's `PORT`)
- Health check: `GET /api/health` returns `200 {"status":"ok"}`

To deploy:

1. In Render, create a **Blueprint** from this repository.
2. When prompted, enter `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_REDIRECT_URI`. These are marked `sync: false`, so they are stored only in Render. `PAYPAL_ENVIRONMENT` is set to `SANDBOX` in `render.yaml`.
3. Set `PAYPAL_REDIRECT_URI` to `https://<your-service>.onrender.com/api/auth/paypal/callback`.
4. In the PayPal developer dashboard, add that exact URL as a return URL for Log in with PayPal on the app.
