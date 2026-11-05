import { NextResponse, type NextRequest } from "next/server";
import {
  checkCallback,
  STATE_COOKIE,
  STATE_COOKIE_OPTIONS,
} from "@/src/lib/auth/oauth-state";
import { PayPalApiError } from "@/src/lib/paypal/errors";
import {
  getVerifiedProfile,
  type VerifiedProfile,
} from "@/src/lib/paypal/identity";

const FAILURE_MESSAGES = {
  state_mismatch: "This login link is invalid or has expired. Please start again.",
  provider_error: "PayPal login was cancelled or did not complete.",
  missing_code: "PayPal did not return an authorization code.",
  exchange_failed: "We could not verify your PayPal account. Please try again.",
} as const;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const check = checkCallback({
    cookieState: request.cookies.get(STATE_COOKIE)?.value,
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
  });

  if (!check.ok) {
    return page(400, failureHtml(FAILURE_MESSAGES[check.reason]));
  }

  try {
    const profile = await getVerifiedProfile(check.code);
    return page(200, profileHtml(profile));
  } catch (err) {
    // Log only status and debug_id; never the error object, which could
    // reference request data such as the token.
    if (err instanceof PayPalApiError) {
      console.error(
        `PayPal verification failed: ${err.operation} status=${err.status} debug_id=${err.debugId ?? "none"}`,
      );
    } else {
      console.error("PayPal verification failed: unexpected error");
    }
    return page(502, failureHtml(FAILURE_MESSAGES.exchange_failed));
  }
}

function page(status: number, body: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PayPal verification</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}dt{font-weight:600;margin-top:.75rem}dd{margin:0;font-family:ui-monospace,monospace}</style></head><body>${body}<p><a href="/verify">Back</a></p></body></html>`;
  const res = new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
  // The state is single-use: clear it whatever the outcome.
  res.cookies.set(STATE_COOKIE, "", { ...STATE_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

function failureHtml(message: string): string {
  return `<h1>Verification failed</h1><p>${escapeHtml(message)}</p>`;
}

function profileHtml(p: VerifiedProfile): string {
  const rows: [string, string][] = [
    ["payer_id", p.payerId],
    ["Verified account", p.verifiedAccount ? "Yes" : "No"],
    ["Name", p.name ?? "(not provided)"],
    ["Email", p.email ?? "(not provided)"],
    ["Email confirmed", p.emailConfirmed ? "Yes" : "No"],
  ];
  const list = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
  return `<h1>PayPal account verified</h1><dl>${list}</dl>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
