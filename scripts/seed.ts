/**
 * Seeds sample data: one operator, one approver and a few payees.
 * Safe to re-run: rows have fixed ids and existing ones are left alone.
 *
 *   DATABASE_URL=postgresql://localhost:5432/verified_payouts npm run db:seed
 */
import { Client } from "pg";
import type { AuditEntryInput } from "../src/lib/audit/chain";
import { appendAuditEntry, verifyAuditLog } from "../src/lib/audit/log";

const OPERATOR_ID = "5eed0000-0000-4000-8000-000000000001";
const APPROVER_ID = "5eed0000-0000-4000-8000-000000000002";

const USERS = [
  { id: OPERATOR_ID, email: "operator@example.com", name: "Olivia Operator", role: "operator" },
  { id: APPROVER_ID, email: "approver@example.com", name: "Avery Approver", role: "approver" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

type SeedPayee = {
  id: string;
  displayName: string;
  contactEmail: string;
  contactPhone: string | null;
  deadlineDays: number | null;
  // Sample Log in with PayPal result; payer ids are clearly fake.
  verification: {
    id: string;
    payerId: string;
    verifiedName: string;
    email: string;
  } | null;
};

const PAYEES: SeedPayee[] = [
  {
    // Document name differs from verified name: the AI match case.
    id: "5eed0000-0000-4000-8000-000000000101",
    displayName: "Bob Smith",
    contactEmail: "bob@example.com",
    contactPhone: "+1 555 0101",
    deadlineDays: null,
    verification: {
      id: "5eed0000-0000-4000-8000-000000000201",
      payerId: "SEEDPAYERBOB1",
      verifiedName: "Robert J. Smith",
      email: "robert.smith@example.com",
    },
  },
  {
    // Business payee, invited but not yet verified.
    id: "5eed0000-0000-4000-8000-000000000102",
    displayName: "Studio Kōhaku LLC",
    contactEmail: "hello@kohaku.example.com",
    contactPhone: null,
    deadlineDays: 14,
    verification: null,
  },
  {
    // Existing payee, verified with a Cyrillic name.
    id: "5eed0000-0000-4000-8000-000000000103",
    displayName: "Anna Petrova",
    contactEmail: "anna@example.com",
    contactPhone: "+1 555 0103",
    deadlineDays: null,
    verification: {
      id: "5eed0000-0000-4000-8000-000000000203",
      payerId: "SEEDPAYERANN3",
      verifiedName: "Анна Петрова",
      email: "anna.petrova@example.com",
    },
  },
  {
    // Existing payee invited to verify by a deadline.
    id: "5eed0000-0000-4000-8000-000000000104",
    displayName: "Priya Raman",
    contactEmail: "priya@example.com",
    contactPhone: "+1 555 0104",
    deadlineDays: 30,
    verification: null,
  },
];

async function seed(client: Client) {
  const now = new Date();
  const audit = (entry: Omit<AuditEntryInput, "occurredAt">) =>
    appendAuditEntry(client, {
      occurredAt: now,
      ...entry,
      details: { seed: true, ...entry.details },
    });
  const counts = { users: 0, payees: 0, verifications: 0 };

  for (const u of USERS) {
    const { rowCount } = await client.query(
      `INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.email, u.name, u.role],
    );
    if (!rowCount) continue;
    counts.users++;
    await audit({
      actorType: "system",
      actorId: null,
      action: "user.created",
      entityType: "user",
      entityId: u.id,
      details: { role: u.role },
    });
  }

  for (const p of PAYEES) {
    const deadline = p.deadlineDays === null
      ? null
      : new Date(now.getTime() + p.deadlineDays * DAY_MS);
    const { rowCount } = await client.query(
      `INSERT INTO payees (id, display_name, contact_email, contact_phone,
         verification_deadline, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.displayName, p.contactEmail, p.contactPhone, deadline, OPERATOR_ID],
    );
    if (rowCount) {
      counts.payees++;
      await audit({
        actorType: "user",
        actorId: OPERATOR_ID,
        action: "payee.invited",
        entityType: "payee",
        entityId: p.id,
        details: {},
      });
    }

    const v = p.verification;
    if (!v) continue;
    const inserted = await client.query(
      `INSERT INTO verifications (id, payee_id, paypal_payer_id, verified_account,
         verified_name, email, email_verified, verified_at, status)
       VALUES ($1, $2, $3, true, $4, $5, true, $6, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [v.id, p.id, v.payerId, v.verifiedName, v.email, now],
    );
    if (!inserted.rowCount) continue;
    counts.verifications++;
    await audit({
      actorType: "payee",
      actorId: p.id,
      action: "payee.verified",
      entityType: "verification",
      entityId: v.id,
      details: { paypal_payer_id: v.payerId, verified_account: true },
    });
  }

  return counts;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed sample data with NODE_ENV=production");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL must be set");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const counts = await seed(client);
    const chain = await verifyAuditLog(client);
    if (!chain.ok) throw new Error(`Audit chain invalid: ${JSON.stringify(chain)}`);
    await client.query("COMMIT");
    console.log(
      `Seeded ${counts.users} users, ${counts.payees} payees, ` +
        `${counts.verifications} verifications. Audit chain verified.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
