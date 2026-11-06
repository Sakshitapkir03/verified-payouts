-- Up Migration

-- The receiver as given in the uploaded batch, if any. Used only to check it
-- against the verified account; payouts always go to the verified account.
ALTER TABLE payout_items
  ADD COLUMN receiver_type text CHECK (receiver_type IN ('paypal_id', 'email')),
  ADD COLUMN receiver_value text CHECK (receiver_value <> ''),
  ADD CONSTRAINT payout_items_receiver_complete
    CHECK ((receiver_type IS NULL) = (receiver_value IS NULL));

-- Down Migration

ALTER TABLE payout_items
  DROP CONSTRAINT payout_items_receiver_complete,
  DROP COLUMN receiver_value,
  DROP COLUMN receiver_type;
