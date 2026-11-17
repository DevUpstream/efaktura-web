ALTER TABLE "invoices" DROP CONSTRAINT "invoices_source_ck";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_ck" CHECK ("invoices"."source" in ('app', 'erpnext', 'excel'));--> statement-breakpoint
ALTER TABLE "purchase_invoices" DROP CONSTRAINT "purchase_source_ck";--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_source_ck" CHECK ("source" in ('manual', 'ujp_json', 'erpnext', 'excel'));
