-- Migration: tenant_consistency_constraints
-- See migration_note.md for purpose, rollback, and notes.

-- 1. Customer.organisationId → NOT NULL
ALTER TABLE "Customer" ALTER COLUMN "organisationId" SET NOT NULL;

-- 2. Cross-table constraint: Quote.organisationId must match Customer.organisationId
-- This is defense-in-depth. Application-level checks remain the primary defense.
-- Uses a trigger because PostgreSQL doesn't natively support composite FKs
-- across different parent tables.

CREATE OR REPLACE FUNCTION check_quote_customer_same_organisation()
RETURNS TRIGGER AS $$
DECLARE
  customer_org TEXT;
BEGIN
  SELECT "organisationId" INTO customer_org FROM "Customer" WHERE id = NEW."customerId";
  IF customer_org IS NULL OR customer_org <> NEW."organisationId" THEN
    RAISE EXCEPTION 'Quote organisationId (%) does not match customer organisationId (%)',
      NEW."organisationId", customer_org;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quote_customer_same_org_trigger ON "Quote";
CREATE TRIGGER quote_customer_same_org_trigger
  BEFORE INSERT OR UPDATE OF "customerId", "organisationId" ON "Quote"
  FOR EACH ROW
  EXECUTE FUNCTION check_quote_customer_same_organisation();
