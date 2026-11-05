import { z } from "zod";

/**
 * A failed PayPal API call. Carries only what is safe to log: the operation,
 * HTTP status and PayPal's debug_id. Never response bodies or tokens.
 */
export class PayPalApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly debugId: string | null,
  ) {
    super(
      `PayPal ${operation} failed (status ${status}, debug_id ${debugId ?? "none"})`,
    );
    this.name = "PayPalApiError";
  }
}

const DebugIdBody = z.object({ debug_id: z.string().min(1) });

function debugIdOf(res: Response, body: unknown): string | null {
  const header = res.headers.get("paypal-debug-id");
  if (header) return header;
  const parsed = DebugIdBody.safeParse(body);
  return parsed.success ? parsed.data.debug_id : null;
}

/**
 * Parses a PayPal JSON response against a schema. Throws PayPalApiError on a
 * non-2xx status or an unexpected body.
 */
export async function readPayPalJson<S extends z.ZodType>(
  res: Response,
  schema: S,
  operation: string,
): Promise<z.output<S>> {
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new PayPalApiError(operation, res.status, debugIdOf(res, body));
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PayPalApiError(operation, res.status, debugIdOf(res, body));
  }
  return parsed.data;
}
