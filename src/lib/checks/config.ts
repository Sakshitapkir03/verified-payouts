import { z } from "zod";

/** Limits for the rule checks. All are configurable; see README. */
export type CheckConfig = {
  /** A payee's first payment above this needs a hold and a second approver. */
  firstPaymentLimitCents: number;
  /** Hold an amount above this percentage of the payee's median (300 = 3x). */
  medianMultiplierPercent: number;
  /** Completed payments needed before the median rule applies. */
  medianMinHistory: number;
  /** Also treat same payee and amount within this many days as a duplicate. 0 = this batch only. */
  duplicateWindowDays: number;
};

const SETTINGS = {
  firstPaymentLimitCents: { env: "CHECK_FIRST_PAYMENT_LIMIT_CENTS", min: 0, fallback: 30000 },
  medianMultiplierPercent: { env: "CHECK_MEDIAN_MULTIPLIER_PERCENT", min: 100, fallback: 300 },
  medianMinHistory: { env: "CHECK_MEDIAN_MIN_HISTORY", min: 1, fallback: 3 },
  duplicateWindowDays: { env: "CHECK_DUPLICATE_WINDOW_DAYS", min: 0, fallback: 3 },
} as const satisfies Record<keyof CheckConfig, { env: string; min: number; fallback: number }>;

export const DEFAULT_CHECK_CONFIG: CheckConfig = {
  firstPaymentLimitCents: SETTINGS.firstPaymentLimitCents.fallback,
  medianMultiplierPercent: SETTINGS.medianMultiplierPercent.fallback,
  medianMinHistory: SETTINGS.medianMinHistory.fallback,
  duplicateWindowDays: SETTINGS.duplicateWindowDays.fallback,
};

function wholeNumber(min: number, fallback: number) {
  return z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .optional()
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(Number.MAX_SAFE_INTEGER));
}

/**
 * Reads limits from the environment, falling back to defaults for unset or
 * empty values. Invalid values throw so a typo never silently loosens a check.
 */
export function loadCheckConfig(
  env: Record<string, string | undefined> = process.env,
): CheckConfig {
  const config = {} as CheckConfig;
  for (const [key, s] of Object.entries(SETTINGS) as [keyof CheckConfig, (typeof SETTINGS)[keyof CheckConfig]][]) {
    const raw = env[s.env];
    const parsed = wholeNumber(s.min, s.fallback).safeParse(raw === "" ? undefined : raw);
    if (!parsed.success) {
      throw new Error(`${s.env} must be a whole number of at least ${s.min}`);
    }
    config[key] = parsed.data;
  }
  return config;
}
