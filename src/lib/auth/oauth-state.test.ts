import { describe, expect, it } from "vitest";
import {
  checkCallback,
  generateState,
  STATE_COOKIE_OPTIONS,
  statesMatch,
} from "./oauth-state";

describe("STATE_COOKIE_OPTIONS", () => {
  it("is SameSite=Lax so it survives PayPal's cross-site redirect back", () => {
    expect(STATE_COOKIE_OPTIONS.sameSite).toBe("lax");
  });

  it("is httpOnly, Secure and scoped to the callback", () => {
    expect(STATE_COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(STATE_COOKIE_OPTIONS.secure).toBe(true);
    expect(STATE_COOKIE_OPTIONS.path).toBe("/api/auth/paypal/callback");
  });
});

describe("generateState", () => {
  it("returns a 256-bit base64url value", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("returns a different value each time", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("statesMatch", () => {
  const state = generateState();

  it("accepts identical states", () => {
    expect(statesMatch(state, state)).toBe(true);
  });

  it("rejects a different state of the same length", () => {
    expect(statesMatch(state, generateState())).toBe(false);
  });

  it("rejects a state of a different length", () => {
    expect(statesMatch(state, state.slice(1))).toBe(false);
    expect(statesMatch(state, state + "x")).toBe(false);
  });

  it("rejects a missing cookie", () => {
    expect(statesMatch(undefined, state)).toBe(false);
  });

  it("rejects a missing query state", () => {
    expect(statesMatch(state, null)).toBe(false);
  });

  it("rejects when both are empty", () => {
    expect(statesMatch("", "")).toBe(false);
    expect(statesMatch(undefined, null)).toBe(false);
  });
});

describe("checkCallback", () => {
  const state = generateState();

  it("returns the code when state matches", () => {
    expect(
      checkCallback({ cookieState: state, state, code: "abc", error: null }),
    ).toEqual({ ok: true, code: "abc" });
  });

  it("rejects a state mismatch even when a code is present", () => {
    expect(
      checkCallback({
        cookieState: state,
        state: generateState(),
        code: "abc",
        error: null,
      }),
    ).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("rejects a callback with no state cookie", () => {
    expect(
      checkCallback({ cookieState: undefined, state, code: "abc", error: null }),
    ).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("checks state before reporting a provider error", () => {
    expect(
      checkCallback({
        cookieState: state,
        state: "forged",
        code: null,
        error: "access_denied",
      }),
    ).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("reports a provider error when state matches", () => {
    expect(
      checkCallback({
        cookieState: state,
        state,
        code: null,
        error: "access_denied",
      }),
    ).toEqual({ ok: false, reason: "provider_error" });
  });

  it("rejects a matching state with no code", () => {
    expect(
      checkCallback({ cookieState: state, state, code: null, error: null }),
    ).toEqual({ ok: false, reason: "missing_code" });
  });
});
