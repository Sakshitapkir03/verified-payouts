# Fairfee — Scope Document

**Status:** Draft v1 · **Hackathon:** Build What's Next with PayPal and AI · **Deadline:** confirm on Devpost (Nov 12, 2026)

## 1. Problem

When an order crosses borders, the import charges (duties, import taxes, carrier fees) a customer pays at checkout are only an estimate. The actual charges often come in higher or lower. Today, small merchants rarely settle that difference: customers silently overpay, merchants silently absorb shortfalls, and customers are sometimes charged twice (at checkout and again at the door).

## 2. Solution

Fairfee is a duty and fee reconciliation engine for merchants who sell internationally through PayPal. It reads the actual charge documents the merchant already has (carrier PDFs, broker statements, customer receipt photos), matches them to PayPal orders, and settles each difference through PayPal, with a human approving every money movement.

- **Customer overpaid** → partial PayPal refund
- **Customer underpaid** → absorb (default for small amounts) or send a PayPal invoice, within caps
- **Customer charged twice** → refund the duplicate charge

## 3. Users

| User | What they get |
|---|---|
| Small and mid-sized cross-border merchants (primary) | Hours of manual reconciliation saved, fewer absorbed losses, fewer disputes |
| Their customers (indirect) | Automatic refunds when they overpaid, clear explanations |

## 4. Core flow

1. **Orders** exist in PayPal, with the estimated import charge recorded as a separate amount.
2. **Upload:** the merchant drops in documents in any format (PDF, image, spreadsheet, pasted email).
3. **Extract (AI):** read each document; pull tracking numbers, charge lines, amounts, currency.
4. **Classify (AI):** label each charge line (duty, import tax, carrier fee, storage fee, correction) and who should bear it.
5. **Match (AI):** link each charge to a PayPal order using tracking number, name, address, date and amount, with a confidence score.
6. **Compute (code):** difference = actual customer-borne charges − estimate paid.
7. **Policy (code):** apply merchant rules and caps; skip unsafe cases.
8. **Approve (human):** review table with every proposed action, totals and flags.
9. **Execute (code):** PayPal refunds and invoices, each with an idempotency key.
10. **Audit:** append-only record of every step.

## 5. AI vs. code (design principle)

**AI reads and judges. Code calculates and moves money.** The AI never calls a money-moving PayPal endpoint.

| AI does | Code does |
|---|---|
| Extract data from any document layout or language | All arithmetic and currency math |
| Classify charge lines | Policy rules and caps |
| Fuzzy-match documents to orders, with confidence | Every PayPal API call |
| Check customer-submitted receipts for inconsistencies | Idempotency, dry-run, audit log |
| Write a clear explanation for each customer | Schema validation of all AI output |

## 6. Scope

**In scope (must work at submission)**
- Seed 20–30 sandbox orders with import charges across a few routes
- Upload mixed documents: at least two carrier PDF formats and one receipt photo
- AI extraction, classification and matching, validated against a schema
- Policy engine with configurable rules
- Approval screen (table, totals, flags)
- Executor: real sandbox partial refunds and invoices
- Audit log
- Hosted demo, README with run instructions, demo video under 3 minutes

**Stretch (only if core is done by day 5)**
- Pass-through of a duty or fee refund received from a carrier
- Route insights (which origin→destination routes have the biggest gaps)
- Customer messages in the customer's language

**Out of scope**
- Calculating duty rates
- Integrations with real carriers or stores
- Advice on which goods are allowed in which country
- Login, multiple merchants, billing

## 7. Default policy rules

| Rule | Default |
|---|---|
| Absorb shortfalls under | $5 |
| Max refund per order | Never more than the import charge paid |
| Max invoice per order | $25 or 15% of order total, whichever is lower |
| Open dispute on order | Skip and flag |
| Match confidence below | 0.8 → flag for manual review, no action |
| Order past PayPal refund time limit | Flag; no automatic refund |
| Batch approval | Always required |

## 8. Data model

| Object | Key fields |
|---|---|
| Order | PayPal order ID, capture ID, buyer, route (origin → destination), estimated import charge, currency, tracking number |
| Document | ID, type (carrier invoice, broker statement, receipt photo, email), file, uploaded at |
| ChargeLine | document ID, tracking number, charge type, amount, currency, customer-borne (yes/no) |
| Match | charge line ID, order ID, confidence, reasoning |
| PlanItem | order ID, action (refund / invoice / absorb / skip / review), amount, explanation, policy notes |
| Approval | batch ID, approved items, approved at |
| AuditEntry | timestamp, step, input, output, PayPal response |

## 9. PayPal APIs

| API | Use |
|---|---|
| Orders v2 | Create test orders with import charge as a separate amount; read details |
| Payments v2 (captures, refunds) | Capture payments; partial refunds |
| Invoicing v2 | Create and send shortfall invoices |
| Disputes v1 | Check for open disputes before acting |

## 10. Code structure

| Module | Responsibility |
|---|---|
| `paypal/` | Single client wrapping all PayPal calls (swappable for PayPal MCP later) |
| `ingest/` | Accept uploads; pass files to the AI extractor |
| `ai/` | Extraction, classification, matching, explanations; schema-validated output |
| `policy/` | Pure functions applying rules; unit tested |
| `executor/` | The only code that moves money; dry-run mode; idempotency keys |
| `audit/` | Append-only log |
| `app/` | UI: upload, review, approve, results |

**Stack:** Next.js + TypeScript, Zod for schemas, AI model with PDF and image input (to be chosen), hosted on Render.

## 11. Demo script (under 3 minutes)

| Time | What's shown |
|---|---|
| 0:00–0:25 | The problem: estimated vs. actual import charges; customers overpay, merchants absorb |
| 0:25–1:15 | Drop in two carrier PDFs and a customer receipt photo; AI extracts, classifies, matches |
| 1:15–1:50 | Review table: refunds, an invoice, absorbed amounts, flagged items, explanations |
| 1:50–2:30 | Approve; real sandbox refunds and invoice appear in the buyer accounts |
| 2:30–3:00 | Audit log, design principle (AI reads, code moves money), what's next |

## 12. Definition of done

- [ ] Sandbox orders seeded with import charges
- [ ] Mixed documents extracted and matched correctly in the demo set
- [ ] Policy rules applied and unit tested
- [ ] Approval required before any money moves
- [ ] Real sandbox refunds and invoices executed
- [ ] Audit log viewable
- [ ] Deployed and publicly reachable
- [ ] README: description, AI tools and how they're used, setup and run instructions, sample data labeled as samples
- [ ] MIT license visible
- [ ] Public YouTube demo under 3 minutes
- [ ] Devpost submission complete

## 13. Known limitations

- Carrier documents and receipts in the demo are sample files created for testing
- PayPal limits how long after payment a refund can be issued; older orders are flagged, not refunded
- Invoicing customers for shortfalls is sensitive; caps are low and absorbing is the default
