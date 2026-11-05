import { randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_COOKIE = "paypal_oauth_state";
export const STATE_MAX_AGE_SECONDS = 600;

export const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  // Lax, not Strict: PayPal returns via a top-level cross-site GET, and a
  // Strict cookie would not be sent with it.
  sameSite: "lax",
  path: "/api/auth/paypal/callback",
} as const;

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function statesMatch(
  expected: string | undefined | null,
  received: string | undefined | null,
): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type CallbackParams = {
  cookieState: string | undefined;
  state: string | null;
  code: string | null;
  error: string | null;
};

export type CallbackCheck =
  | { ok: true; code: string }
  | { ok: false; reason: "provider_error" | "state_mismatch" | "missing_code" };

/** Validates the OAuth callback before any code exchange happens. */
export function checkCallback(params: CallbackParams): CallbackCheck {
  if (!statesMatch(params.cookieState, params.state)) {
    return { ok: false, reason: "state_mismatch" };
  }
  if (params.error) return { ok: false, reason: "provider_error" };
  if (!params.code) return { ok: false, reason: "missing_code" };
  return { ok: true, code: params.code };
}
