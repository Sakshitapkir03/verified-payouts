-- Up Migration

-- Monitor mode is not in v1 (see Roadmap in docs/SCOPE.md).
ALTER TABLE payees DROP COLUMN monitor_mode;

-- Down Migration

ALTER TABLE payees ADD COLUMN monitor_mode boolean NOT NULL DEFAULT false;
