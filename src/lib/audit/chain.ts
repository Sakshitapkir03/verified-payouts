import { createHash } from "node:crypto";
import { z } from "zod";

// Bump if the hashed fields or their encoding ever change, so old entries
// keep verifying under the rules they were written with.
const HASH_VERSION = "v1";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Details must survive a Postgres jsonb round trip unchanged, or stored
 * entries would stop verifying. So numbers are safe integers only (money is
 * integer cents anyway) and strings must be well-formed without NUL.
 */
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().int().refine(Number.isSafeInteger, "must be a safe integer"),
    z
      .string()
      .refine((s) => s.isWellFormed() && !s.includes("\u0000"), {
        message: "must be well-formed and contain no NUL",
      }),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const AuditEntryInputSchema = z.object({
  occurredAt: z.date(),
  actorType: z.enum(["user", "payee", "system"]),
  // Postgres returns uuids lowercase; normalize so hashes match on read-back.
  actorId: z.uuid().transform((s) => s.toLowerCase()).nullable(),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1).nullable(),
  details: z.record(z.string(), JsonValueSchema),
}).refine((e) => (e.actorType === "system") === (e.actorId === null), {
  message: "actorId is required for user and payee actors, and must be null for system",
  path: ["actorId"],
});

export type AuditEntryInput = z.input<typeof AuditEntryInputSchema>;
export type AuditEntryData = z.output<typeof AuditEntryInputSchema>;

export type AuditEntry = AuditEntryData & {
  prevHash: string | null;
  hash: string;
};

/** JSON with object keys sorted at every level, so key order never matters. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over the previous hash and every stored field of the entry. */
export function computeEntryHash(
  prevHash: string | null,
  entry: AuditEntryData,
): string {
  const payload = canonicalJson([
    HASH_VERSION,
    prevHash,
    entry.occurredAt.toISOString(),
    entry.actorType,
    entry.actorId,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.details,
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Validates the input and links it to the previous entry. */
export function buildEntry(
  prevHash: string | null,
  input: AuditEntryInput,
): AuditEntry {
  const data = AuditEntryInputSchema.parse(input);
  return { ...data, prevHash, hash: computeEntryHash(prevHash, data) };
}

export type ChainCheck =
  | { ok: true }
  | {
      ok: false;
      index: number;
      reason: "prev_hash_mismatch" | "hash_mismatch";
    };

/**
 * Verifies entries in log order. `expectedPrevHash` is null for a full log,
 * or the hash before the first entry when checking a segment.
 */
export function verifyChain(
  entries: readonly AuditEntry[],
  expectedPrevHash: string | null = null,
): ChainCheck {
  let prev = expectedPrevHash;
  for (const [index, entry] of entries.entries()) {
    if (entry.prevHash !== prev) {
      return { ok: false, index, reason: "prev_hash_mismatch" };
    }
    if (computeEntryHash(entry.prevHash, entry) !== entry.hash) {
      return { ok: false, index, reason: "hash_mismatch" };
    }
    prev = entry.hash;
  }
  return { ok: true };
}
