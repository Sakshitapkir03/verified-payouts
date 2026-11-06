-- Up Migration

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Sent to PayPal as sender_batch_id; unique so a batch is never sent twice.
  sender_batch_id text NOT NULL UNIQUE,
  uploaded_by uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'checked', 'sent', 'closed')),
  paypal_payout_batch_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE TABLE payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches (id),
  line_number integer NOT NULL CHECK (line_number > 0),
  payee_id uuid NOT NULL REFERENCES payees (id),
  -- The verified account this item pays; set when checks pass.
  verification_id uuid REFERENCES verifications (id),
  -- Money is integer cents, USD only in v1.
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- Changes go through the app's state machine; this only bounds the values.
  state text NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft', 'held', 'ready', 'approved', 'sent', 'completed',
    'unclaimed', 'returned', 'failed', 'blocked', 'cancelled'
  )),
  -- [{ "code": "...", "source": "rule" | "ai", "explanation": "..." }]
  hold_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(hold_reasons) = 'array'),
  -- Sent to PayPal as sender_item_id; unique for idempotency.
  sender_item_id text NOT NULL UNIQUE,
  paypal_item_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, line_number),
  CHECK (state NOT IN ('held', 'blocked') OR jsonb_array_length(hold_reasons) > 0),
  CHECK (state NOT IN ('approved', 'sent', 'completed') OR verification_id IS NOT NULL)
);
CREATE INDEX payout_items_payee_id_idx ON payout_items (payee_id);
CREATE INDEX payout_items_state_idx ON payout_items (state);

-- An approval covers either a payout item or an account change.
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approver_id uuid NOT NULL REFERENCES users (id),
  payout_item_id uuid REFERENCES payout_items (id),
  verification_id uuid REFERENCES verifications (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(payout_item_id, verification_id) = 1)
);
-- One decision per approver per subject, so a second approver must be a
-- different person.
CREATE UNIQUE INDEX approvals_one_per_approver_item
  ON approvals (payout_item_id, approver_id) WHERE payout_item_id IS NOT NULL;
CREATE UNIQUE INDEX approvals_one_per_approver_verification
  ON approvals (verification_id, approver_id) WHERE verification_id IS NOT NULL;

-- Down Migration

DROP TABLE approvals;
DROP TABLE payout_items;
DROP TABLE batches;
