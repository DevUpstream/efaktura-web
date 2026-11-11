-- Vlezni fakturi prenesени od ERPNext (docs/11): nov izvor "erpnext"
ALTER TABLE "purchase_invoices" DROP CONSTRAINT "purchase_source_ck";--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_source_ck" CHECK ("source" in ('manual', 'ujp_json', 'erpnext'));
