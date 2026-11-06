import { z } from "zod";

/** One reason an item is held or blocked. Stored in payout_items.hold_reasons. */
export const HoldReasonSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  action: z.enum(["hold", "block"]),
  source: z.enum(["rule", "ai"]),
  explanation: z.string().min(1),
  requiresSecondApprover: z.boolean(),
}).refine((h) => h.source !== "ai" || h.action === "hold", {
  // AI may only add holds, never block, remove or approve.
  message: "AI may only add holds",
  path: ["action"],
});

export type HoldReason = z.infer<typeof HoldReasonSchema>;

export const HoldReasonsSchema = z.array(HoldReasonSchema);

/** Items with a second-approver hold need two different approvers. */
export function requiredApprovals(holds: readonly HoldReason[]): 1 | 2 {
  return holds.some((h) => h.requiresSecondApprover) ? 2 : 1;
}
