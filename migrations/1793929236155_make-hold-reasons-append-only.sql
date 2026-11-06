-- Up Migration

-- Hold reasons are append-only, even for the state machine: existing
-- reasons must stay first, in order and unchanged. Holds are added, never
-- removed; clearing an item is an approval, not an edit.
CREATE OR REPLACE FUNCTION payout_items_guard_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_array_length(OLD.hold_reasons) > 0 AND (
    jsonb_array_length(NEW.hold_reasons) < jsonb_array_length(OLD.hold_reasons)
    OR (
      SELECT jsonb_agg(e ORDER BY i)
      FROM jsonb_array_elements(NEW.hold_reasons) WITH ORDINALITY AS t(e, i)
      WHERE i <= jsonb_array_length(OLD.hold_reasons)
    ) IS DISTINCT FROM OLD.hold_reasons
  ) THEN
    RAISE EXCEPTION 'payout_items: hold reasons can be added but never removed or changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF current_setting('verified_payouts.state_machine', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.hold_reasons <> '[]'::jsonb THEN
      RAISE EXCEPTION 'payout_items: new items must start in draft with no holds'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state
     OR NEW.hold_reasons IS DISTINCT FROM OLD.hold_reasons THEN
    RAISE EXCEPTION 'payout_items: state and holds change only through the state machine'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION payout_items_guard_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('verified_payouts.state_machine', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.hold_reasons <> '[]'::jsonb THEN
      RAISE EXCEPTION 'payout_items: new items must start in draft with no holds'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state
     OR NEW.hold_reasons IS DISTINCT FROM OLD.hold_reasons THEN
    RAISE EXCEPTION 'payout_items: state and holds change only through the state machine'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
