-- Up Migration

-- Staff accounts. Roles per docs/SCOPE.md; permissions are enforced in the app.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('operator', 'approver')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- People the business pays. Contact details are used for account-change
-- notices and phone confirmation, never as the payout destination.
CREATE TABLE payees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  contact_email text NOT NULL,
  contact_phone text,
  -- Rollout: monitor mode pays as before; checks report only.
  monitor_mode boolean NOT NULL DEFAULT false,
  verification_deadline timestamptz,
  -- An approver cannot approve payees they invited or changed.
  invited_by uuid NOT NULL REFERENCES users (id),
  last_changed_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payees_invited_by_idx ON payees (invited_by);

-- Results of Log in with PayPal. Access tokens are never stored.
CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id uuid NOT NULL REFERENCES payees (id) ON DELETE CASCADE,
  paypal_payer_id text NOT NULL,
  verified_account boolean NOT NULL,
  verified_name text,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL,
  -- pending: an account change awaiting approval.
  -- active: the account payouts go to. superseded: replaced by a change.
  status text NOT NULL CHECK (status IN ('pending', 'active', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX verifications_one_active_per_payee
  ON verifications (payee_id) WHERE status = 'active';
-- Not unique: two payees sharing an account is a hold, not a constraint.
CREATE INDEX verifications_paypal_payer_id_idx ON verifications (paypal_payer_id);

-- Down Migration

DROP TABLE verifications;
DROP TABLE payees;
DROP TABLE users;
