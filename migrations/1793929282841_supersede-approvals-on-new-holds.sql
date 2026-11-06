-- Up Migration

-- When holds are added to an item, earlier approvals no longer count: the
-- approver hasn't seen the new reasons. They are kept, marked superseded,
-- and the same approver may approve again.
ALTER TABLE approvals ADD COLUMN superseded_at timestamptz;

DROP INDEX approvals_one_per_approver_item;
CREATE UNIQUE INDEX approvals_one_per_approver_item
  ON approvals (payout_item_id, approver_id)
  WHERE payout_item_id IS NOT NULL AND superseded_at IS NULL;

-- Down Migration

DROP INDEX approvals_one_per_approver_item;
CREATE UNIQUE INDEX approvals_one_per_approver_item
  ON approvals (payout_item_id, approver_id) WHERE payout_item_id IS NOT NULL;
ALTER TABLE approvals DROP COLUMN superseded_at;
