import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PayPalApiError, readPayPalJson } from "./errors";

const Schema = z.object({ access_token: z.string() });
const TOKEN = "A21AAsecret-access-token";

function json(body: unknown, status: number, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function caught(promise: Promise<unknown>): Promise<PayPalApiError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PayPalApiError);
  return err as PayPalApiError;
}

describe("readPayPalJson", () => {
  it("returns the parsed body on success", async () => {
    const res = json({ access_token: TOKEN, scope: "openid" }, 200);
    await expect(readPayPalJson(res, Schema, "token exchange")).resolves.toEqual(
      { access_token: TOKEN },
    );
  });

  it("takes debug_id from the paypal-debug-id header", async () => {
    const res = json({ error: "invalid_grant" }, 401, {
      "paypal-debug-id": "f00dbabe1234",
    });
    const err = await caught(readPayPalJson(res, Schema, "token exchange"));
    expect(err.status).toBe(401);
    expect(err.debugId).toBe("f00dbabe1234");
    expect(err.message).toContain("debug_id f00dbabe1234");
  });

  it("falls back to debug_id in the error body", async () => {
    const res = json({ name: "INTERNAL_ERROR", debug_id: "abc123" }, 500);
    const err = await caught(readPayPalJson(res, Schema, "userinfo"));
    expect(err.debugId).toBe("abc123");
  });

  it("reports none when PayPal gives no debug_id", async () => {
    const res = new Response("not json", { status: 502 });
    const err = await caught(readPayPalJson(res, Schema, "userinfo"));
    expect(err.debugId).toBeNull();
    expect(err.message).toContain("debug_id none");
  });

  it("throws with debug_id when a 2xx body fails validation", async () => {
    const res = json({ unexpected: true }, 200, { "paypal-debug-id": "d1" });
    const err = await caught(readPayPalJson(res, Schema, "token exchange"));
    expect(err.status).toBe(200);
    expect(err.debugId).toBe("d1");
  });

  it("never includes the response body in the error", async () => {
    const res = json(
      { access_token: TOKEN, error: "server_error", debug_id: "d2" },
      500,
    );
    const err = await caught(readPayPalJson(res, Schema, "token exchange"));
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(
      TOKEN,
    );
    expect(String(err)).not.toContain(TOKEN);
  });
});
