ALTER TABLE "Payment" ADD COLUMN "receiptNumber" TEXT;
UPDATE "Payment" SET "receiptNumber" = 'RCP-' || UPPER("id") WHERE "receiptNumber" IS NULL;
ALTER TABLE "Payment" ALTER COLUMN "receiptNumber" SET NOT NULL;
CREATE UNIQUE INDEX "Payment_receiptNumber_key" ON "Payment"("receiptNumber");

-- Older running API instances do not yet know the new column. Keep their inserts valid during rollout.
CREATE OR REPLACE FUNCTION assign_payment_receipt_number() RETURNS trigger AS $$
BEGIN
  IF NEW."receiptNumber" IS NULL OR NEW."receiptNumber" = '' THEN
    NEW."receiptNumber" := 'RCP-' || UPPER(NEW."id");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Payment_assign_receipt_number"
BEFORE INSERT ON "Payment"
FOR EACH ROW EXECUTE FUNCTION assign_payment_receipt_number();
