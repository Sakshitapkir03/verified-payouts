-- Up Migration

-- Append-only audit log. Each entry stores the previous entry's hash, so
-- editing, deleting or reordering past entries breaks the chain. Hashes are
-- computed in src/lib/audit/chain.ts; the database enforces the links.
CREATE TABLE audit_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'payee', 'system')),
  -- No foreign keys: the log must outlive the rows it describes.
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  -- NULL only for the first entry.
  prev_hash text CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  CHECK ((actor_type = 'system') = (actor_id IS NULL)),
  -- No two entries may follow the same entry (and only one may start the
  -- chain), so concurrent writers cannot fork it.
  CONSTRAINT audit_entries_prev_hash_key UNIQUE NULLS NOT DISTINCT (prev_hash)
);

CREATE FUNCTION audit_entries_check_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tail text;
BEGIN
  -- Serialize appends; the app takes the same lock before reading the tail.
  PERFORM pg_advisory_xact_lock(hashtext('audit_entries'));
  SELECT hash INTO tail FROM audit_entries ORDER BY id DESC LIMIT 1;
  IF NEW.prev_hash IS DISTINCT FROM tail THEN
    RAISE EXCEPTION 'audit_entries: prev_hash must equal the hash of the latest entry'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_entries_link
  BEFORE INSERT ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_entries_check_link();

CREATE FUNCTION audit_entries_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_entries_reject_change();

CREATE TRIGGER audit_entries_no_truncate
  BEFORE TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION audit_entries_reject_change();

-- Down Migration

DROP TABLE audit_entries;
DROP FUNCTION audit_entries_reject_change();
DROP FUNCTION audit_entries_check_link();
