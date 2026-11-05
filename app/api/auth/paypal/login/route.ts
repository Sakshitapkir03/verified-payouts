import { NextResponse } from "next/server";
import {
  generateState,
  STATE_COOKIE,
  STATE_COOKIE_OPTIONS,
  STATE_MAX_AGE_SECONDS,
} from "@/src/lib/auth/oauth-state";
import { buildAuthorizeUrl } from "@/src/lib/paypal/identity";

export async function GET() {
  const state = generateState();
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    ...STATE_COOKIE_OPTIONS,
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  return res;
}
