DROP INDEX "invoices_ujp_pending_ix";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "source" varchar(12) DEFAULT 'app' NOT NULL;--> statement-breakpoint
CREATE INDEX "invoices_ujp_pending_ix" ON "invoices" USING btree ("status") WHERE "invoices"."status" = 'issued' and "invoices"."ujp_id" is null and "invoices"."source" = 'app';--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_ck" CHECK ("invoices"."source" in ('app', 'erpnext'));