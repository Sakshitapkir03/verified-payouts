import { connection } from "next/server";

export async function GET() {
  // Run per request so the health check reflects the live server,
  // not a response prerendered at build time.
  await connection();
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
