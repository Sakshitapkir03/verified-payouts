-- Up Migration

-- Payout item state and hold reasons may only change through the state
-- machine (src/lib/payouts/state-machine.ts), which sets this flag around
-- its own writes. This stops other code paths from skipping transitions,
-- skipping the audit entry, or removing holds. It guards against mistakes,
-- not against someone with direct database access.
CREATE FUNCTION payout_items_guard_state() RETURNS trigger
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

CREATE TRIGGER payout_items_guard_state
  BEFORE INSERT OR UPDATE ON payout_items
  FOR EACH ROW EXECUTE FUNCTION payout_items_guard_state();

-- Down Migration

DROP TRIGGER payout_items_guard_state ON payout_items;
DROP FUNCTION payout_items_guard_state();
