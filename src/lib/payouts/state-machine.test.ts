import { describe, expect, it } from "vitest";
import type { HoldReason } from "./holds";
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  PAYOUT_ITEM_STATES,
  PayoutItemError,
  validateTransitionHolds,
  type ActorKind,
  type PayoutItemState,
} from "./state-machine";

const ACTORS: ActorKind[] = ["checks", "ai", "user", "approval", "executor", "paypal"];

// Written out independently of TRANSITIONS so a change to the table must be
// mirrored here deliberately.
const ALLOWED = new Set([
  "draft>ready:checks",
  "draft>held:checks",
  "draft>held:ai",
  "draft>blocked:checks",
  "draft>cancelled:user",
  "held>approved:approval",
  "held>blocked:checks",
  "held>cancelled:user",
  "ready>approved:approval",
  "ready>held:checks",
  "ready>held:ai",
  "ready>blocked:checks",
  "ready>cancelled:user",
  "approved>sent:executor",
  "approved>held:checks",
  "approved>held:ai",
  "approved>blocked:checks",
  "approved>cancelled:user",
  "sent>completed:paypal",
  "sent>unclaimed:paypal",
  "sent>returned:paypal",
  "sent>failed:paypal",
  "unclaimed>completed:paypal",
  "unclaimed>returned:paypal",
  "unclaimed>cancelled:paypal",
  "blocked>cancelled:user",
]);

const ALL_CASES = PAYOUT_ITEM_STATES.flatMap((from) =>
  PAYOUT_ITEM_STATES.flatMap((to) =>
    ACTORS.map((actor) => ({ from, to, actor, key: `${from}>${to}:${actor}` })),
  ),
);

describe("transition table", () => {
  it("matches the states in docs/SCOPE.md", () => {
    expect(PAYOUT_ITEM_STATES).toEqual([
      "draft", "held", "ready", "approved", "sent", "completed",
      "unclaimed", "returned", "failed", "blocked", "cancelled",
    ]);
  });

  it.each(ALL_CASES.filter((c) => ALLOWED.has(c.key)))(
    "allows $from → $to by $actor",
    ({ from, to, actor }) => {
      expect(canTransition(from, to, actor)).toBe(true);
      expect(() => assertTransition(from, to, actor)).not.toThrow();
    },
  );

  it("rejects every other combination", () => {
    const rejected = ALL_CASES.filter((c) => !ALLOWED.has(c.key));
    expect(rejected).toHaveLength(11 * 11 * ACTORS.length - ALLOWED.size);
    for (const { from, to, actor } of rejected) {
      expect(canTransition(from, to, actor), `${from} → ${to} by ${actor}`).toBe(false);
      expect(() => assertTransition(from, to, actor)).toThrow(IllegalTransitionError);
    }
  });

  it("reports the attempted transition in the error", () => {
    const err = (() => {
      try {
        assertTransition("draft", "sent", "executor");
      } catch (e) {
        return e as IllegalTransitionError;
      }
    })();
    expect(err).toMatchObject({ from: "draft", to: "sent", actor: "executor" });
    expect(err?.message).toBe("Illegal payout item transition draft → sent by executor");
  });

  it.each<PayoutItemState>(["completed", "returned", "failed", "cancelled"])(
    "treats %s as terminal",
    (state) => {
      for (const to of PAYOUT_ITEM_STATES) {
        for (const actor of ACTORS) expect(canTransition(state, to, actor)).toBe(false);
      }
    },
  );

  it("never allows a state to transition to itself", () => {
    for (const s of PAYOUT_ITEM_STATES) {
      for (const actor of ACTORS) expect(canTransition(s, s, actor)).toBe(false);
    }
  });

  it("lets only the executor send", () => {
    const senders = ALL_CASES.filter((c) => c.to === "sent" && canTransition(c.from, c.to, c.actor));
    expect(senders.map((c) => c.key)).toEqual(["approved>sent:executor"]);
  });

  it("reaches approved only through an approval", () => {
    const approvers = ALL_CASES.filter((c) => c.to === "approved" && canTransition(c.from, c.to, c.actor));
    expect(new Set(approvers.map((c) => c.actor))).toEqual(new Set(["approval"]));
  });

  it("lets AI only move items to held", () => {
    const ai = ALL_CASES.filter((c) => c.actor === "ai" && canTransition(c.from, c.to, c.actor));
    expect(new Set(ai.map((c) => c.to))).toEqual(new Set(["held"]));
  });

  it("never moves a held item back to ready", () => {
    for (const actor of ACTORS) expect(canTransition("held", "ready", actor)).toBe(false);
  });

  it("never lets a blocked item be sent or approved", () => {
    for (const actor of ACTORS) {
      expect(canTransition("blocked", "approved", actor)).toBe(false);
      expect(canTransition("blocked", "sent", actor)).toBe(false);
    }
  });

  it("only lets PayPal report results of a sent item", () => {
    const fromSent = ALL_CASES.filter((c) => c.from === "sent" && canTransition(c.from, c.to, c.actor));
    expect(new Set(fromSent.map((c) => c.actor))).toEqual(new Set(["paypal"]));
  });
});

const ruleHold: HoldReason = {
  code: "duplicate_line",
  action: "hold",
  source: "rule",
  explanation: "Same payee and amount on line 4.",
  requiresSecondApprover: false,
};
const ruleBlock: HoldReason = { ...ruleHold, code: "payee_not_verified", action: "block" };
const aiHold: HoldReason = { ...ruleHold, code: "document_name_mismatch", source: "ai" };

function holdsError(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PayoutItemError);
    return (e as PayoutItemError).code;
  }
  return undefined;
}

describe("validateTransitionHolds", () => {
  it("returns the holds for a hold", () => {
    expect(validateTransitionHolds("held", "checks", [ruleHold])).toEqual([ruleHold]);
  });

  it("accepts an AI hold from AI", () => {
    expect(validateTransitionHolds("held", "ai", [aiHold])).toEqual([aiHold]);
  });

  it("accepts a block with extra holds", () => {
    expect(validateTransitionHolds("blocked", "checks", [ruleBlock, ruleHold])).toHaveLength(2);
  });

  it("returns no holds for other targets", () => {
    expect(validateTransitionHolds("ready", "checks", undefined)).toEqual([]);
    expect(validateTransitionHolds("cancelled", "user", [])).toEqual([]);
  });

  it.each<[string, PayoutItemState, ActorKind, HoldReason[] | undefined]>([
    ["held with no reasons", "held", "checks", undefined],
    ["held with an empty list", "held", "checks", []],
    ["blocked with no reasons", "blocked", "checks", []],
    ["held with a block reason", "held", "checks", [ruleBlock]],
    ["blocked with only hold reasons", "blocked", "checks", [ruleHold]],
    ["holds on a non-hold target", "ready", "checks", [ruleHold]],
    ["AI adding a rule hold", "held", "ai", [ruleHold]],
    ["checks adding an AI hold", "held", "checks", [aiHold]],
  ])("rejects %s", (_label, to, actor, holds) => {
    expect(holdsError(() => validateTransitionHolds(to, actor, holds))).toBe("invalid_holds");
  });

  it("rejects an AI block", () => {
    const aiBlock = { ...aiHold, action: "block" } as HoldReason;
    expect(holdsError(() => validateTransitionHolds("blocked", "ai", [aiBlock]))).toBe(
      "invalid_holds",
    );
  });

  it("rejects malformed reasons", () => {
    const bad = [{ ...ruleHold, code: "Not A Code" }];
    expect(holdsError(() => validateTransitionHolds("held", "checks", bad))).toBe("invalid_holds");
    const empty = [{ ...ruleHold, explanation: "" }];
    expect(holdsError(() => validateTransitionHolds("held", "checks", empty))).toBe("invalid_holds");
  });
});
