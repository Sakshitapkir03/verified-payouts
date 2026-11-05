import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REDIRECT_URI, getPayPalConfig } from "./config";

describe("getPayPalConfig redirect URI", () => {
  beforeEach(() => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_ENVIRONMENT", "SANDBOX");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the local callback when unset", () => {
    vi.stubEnv("PAYPAL_REDIRECT_URI", undefined);
    expect(getPayPalConfig().redirectUri).toBe(
      "http://127.0.0.1:3000/api/auth/paypal/callback",
    );
    expect(DEFAULT_REDIRECT_URI).toBe(
      "http://127.0.0.1:3000/api/auth/paypal/callback",
    );
  });

  it("defaults when set to an empty string", () => {
    vi.stubEnv("PAYPAL_REDIRECT_URI", "");
    expect(getPayPalConfig().redirectUri).toBe(DEFAULT_REDIRECT_URI);
  });

  it("uses PAYPAL_REDIRECT_URI exactly as given", () => {
    vi.stubEnv(
      "PAYPAL_REDIRECT_URI",
      "https://payouts.example.com/api/auth/paypal/callback",
    );
    expect(getPayPalConfig().redirectUri).toBe(
      "https://payouts.example.com/api/auth/paypal/callback",
    );
  });

  it("rejects a relative URI", () => {
    vi.stubEnv("PAYPAL_REDIRECT_URI", "/api/auth/paypal/callback");
    expect(() => getPayPalConfig()).toThrow(/absolute URL/);
  });

  it("rejects a non-http scheme", () => {
    vi.stubEnv("PAYPAL_REDIRECT_URI", "javascript:alert(1)");
    expect(() => getPayPalConfig()).toThrow(/http or https/);
  });
});
