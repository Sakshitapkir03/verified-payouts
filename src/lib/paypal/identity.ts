import "server-only";
import { z } from "zod";
import { getPayPalConfig } from "./config";
import { readPayPalJson } from "./errors";

const SCOPES = [
  "openid",
  "profile",
  "email",
  "https://uri.paypal.com/services/paypalattributes",
];

export function buildAuthorizeUrl(state: string): string {
  const { clientId, webBase, redirectUri } = getPayPalConfig();
  const url = new URL("/signin/authorize", webBase);
  url.searchParams.set("flowEntry", "static");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

const TokenResponse = z.object({ access_token: z.string().min(1) });

// PayPal has returned these flags as both booleans and "true"/"false" strings.
const BoolLike = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true");

const UserInfoResponse = z.object({
  payer_id: z.string().min(1),
  name: z.string().optional(),
  verified_account: BoolLike.optional(),
  emails: z
    .array(
      z.object({
        value: z.string(),
        primary: BoolLike.optional(),
        confirmed: BoolLike.optional(),
      }),
    )
    .optional(),
});

export type VerifiedProfile = {
  payerId: string;
  verifiedAccount: boolean;
  name: string | null;
  email: string | null;
  emailConfirmed: boolean;
};

async function exchangeCode(code: string): Promise<string> {
  const { clientId, clientSecret, apiBase } = getPayPalConfig();
  const res = await fetch(new URL("/v1/oauth2/token", apiBase), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
    cache: "no-store",
  });
  const token = await readPayPalJson(res, TokenResponse, "token exchange");
  return token.access_token;
}

async function fetchUserInfo(accessToken: string) {
  const { apiBase } = getPayPalConfig();
  const url = new URL("/v1/identity/oauth2/userinfo", apiBase);
  url.searchParams.set("schema", "paypalv1.1");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  return readPayPalJson(res, UserInfoResponse, "userinfo");
}

/**
 * Exchanges an authorization code for the payee's verified profile.
 * The access token never leaves this function and is not stored.
 */
export async function getVerifiedProfile(
  code: string,
): Promise<VerifiedProfile> {
  const info = await fetchUserInfo(await exchangeCode(code));
  const email =
    info.emails?.find((e) => e.primary) ?? info.emails?.[0] ?? null;
  return {
    payerId: info.payer_id,
    verifiedAccount: info.verified_account ?? false,
    name: info.name ?? null,
    email: email?.value ?? null,
    emailConfirmed: email?.confirmed ?? false,
  };
}
