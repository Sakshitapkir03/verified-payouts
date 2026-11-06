import { describe, expect, it } from "vitest";
import { DEFAULT_CHECK_CONFIG, loadCheckConfig } from "./config";

describe("loadCheckConfig", () => {
  it("uses the documented defaults when nothing is set", () => {
    expect(loadCheckConfig({})).toEqual({
      firstPaymentLimitCents: 30000,
      medianMultiplierPercent: 300,
      medianMinHistory: 3,
      duplicateWindowDays: 3,
    });
    expect(loadCheckConfig({})).toEqual(DEFAULT_CHECK_CONFIG);
  });

  it("treats empty values as unset", () => {
    expect(loadCheckConfig({ CHECK_FIRST_PAYMENT_LIMIT_CENTS: "" })).toEqual(DEFAULT_CHECK_CONFIG);
  });

  it("reads every limit from the environment", () => {
    expect(
      loadCheckConfig({
        CHECK_FIRST_PAYMENT_LIMIT_CENTS: "50000",
        CHECK_MEDIAN_MULTIPLIER_PERCENT: "250",
        CHECK_MEDIAN_MIN_HISTORY: "5",
        CHECK_DUPLICATE_WINDOW_DAYS: "0",
      }),
    ).toEqual({
      firstPaymentLimitCents: 50000,
      medianMultiplierPercent: 250,
      medianMinHistory: 5,
      duplicateWindowDays: 0,
    });
  });

  it("accepts each minimum", () => {
    expect(
      loadCheckConfig({
        CHECK_FIRST_PAYMENT_LIMIT_CENTS: "0",
        CHECK_MEDIAN_MULTIPLIER_PERCENT: "100",
        CHECK_MEDIAN_MIN_HISTORY: "1",
      }),
    ).toMatchObject({ firstPaymentLimitCents: 0, medianMultiplierPercent: 100, medianMinHistory: 1 });
  });

  it.each([
    ["CHECK_FIRST_PAYMENT_LIMIT_CENTS", "300.00"],
    ["CHECK_FIRST_PAYMENT_LIMIT_CENTS", "-1"],
    ["CHECK_FIRST_PAYMENT_LIMIT_CENTS", "abc"],
    ["CHECK_FIRST_PAYMENT_LIMIT_CENTS", " 300"],
    ["CHECK_FIRST_PAYMENT_LIMIT_CENTS", "3e4"],
    ["CHECK_FIRST_PAYMENT_LIMIT_CENTS", "9007199254740992"],
    ["CHECK_MEDIAN_MULTIPLIER_PERCENT", "99"],
    ["CHECK_MEDIAN_MULTIPLIER_PERCENT", "2.5"],
    ["CHECK_MEDIAN_MIN_HISTORY", "0"],
    ["CHECK_DUPLICATE_WINDOW_DAYS", "-3"],
  ])("rejects %s=%j", (name, value) => {
    expect(() => loadCheckConfig({ [name]: value })).toThrow(name);
  });
});
