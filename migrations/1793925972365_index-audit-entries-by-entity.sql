-- Up Migration

-- Approval checks look up every user who has acted on a payee.
CREATE INDEX audit_entries_entity_idx ON audit_entries (entity_type, entity_id);

-- Down Migration

DROP INDEX audit_entries_entity_idx;
