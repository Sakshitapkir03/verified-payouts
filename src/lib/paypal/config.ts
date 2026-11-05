import "server-only";

export const DEFAULT_REDIRECT_URI =
  "http://127.0.0.1:3000/api/auth/paypal/callback";

const HOSTS = {
  SANDBOX: {
    web: "https://www.sandbox.paypal.com",
    api: "https://api-m.sandbox.paypal.com",
  },
  LIVE: {
    web: "https://www.paypal.com",
    api: "https://api-m.paypal.com",
  },
} as const;

export type PayPalConfig = {
  clientId: string;
  clientSecret: string;
  webBase: string;
  apiBase: string;
  redirectUri: string;
};

export function getPayPalConfig(): PayPalConfig {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const environment = process.env.PAYPAL_ENVIRONMENT;

  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  }
  if (environment !== "SANDBOX" && environment !== "LIVE") {
    throw new Error("PAYPAL_ENVIRONMENT must be SANDBOX or LIVE");
  }

  const hosts = HOSTS[environment];
  return {
    clientId,
    clientSecret,
    webBase: hosts.web,
    apiBase: hosts.api,
    redirectUri: parseRedirectUri(process.env.PAYPAL_REDIRECT_URI),
  };
}

function parseRedirectUri(value: string | undefined): string {
  if (!value) return DEFAULT_REDIRECT_URI;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PAYPAL_REDIRECT_URI must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PAYPAL_REDIRECT_URI must use http or https");
  }
  // Returned as given: PayPal requires an exact match with the registered URI.
  return value;
}
