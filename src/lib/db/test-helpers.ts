import { Client } from "pg";
import { afterAll, beforeAll } from "vitest";

/**
 * Database tests run against TEST_DATABASE_URL and are skipped without it.
 * Every test runs in a transaction that is always rolled back: audit entries
 * are append-only, so anything committed could never be cleaned up.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function useTestDatabase() {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  return async function inRollback<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    await client.query("BEGIN");
    try {
      return await fn(client);
    } finally {
      await client.query("ROLLBACK");
    }
  };
}

/** Postgres SQLSTATE of a failed query, for asserting which rule rejected it. */
export async function sqlState(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => {
      throw new Error("expected the query to fail");
    },
    (e: unknown) => e,
  );
  return (err as { code?: string }).code ?? String(err);
}
