CREATE TABLE "exchange_rates" (
	"rate_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric(18, 6) NOT NULL,
	"list_date" date NOT NULL,
	"source" varchar(10) DEFAULT 'nbrm' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_rate_date_currency_pk" PRIMARY KEY("rate_date","currency"),
	CONSTRAINT "exchange_rates_rate_ck" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "fx_unit_price" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "fx_net_amount" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "fx_vat_amount" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_net_total" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_vat_total" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_gross_total" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_payable_amount" numeric(18, 2);--> statement-breakpoint
-- docs/16: MKD faktura ima kurs 1 (stari nacrti od SharePoint mozat da imaat drug kurs).
UPDATE "invoices" SET "exchange_rate" = 1 WHERE "currency" = 'MKD' AND "exchange_rate" <> 1 AND "legacy_sp_id" IS NULL AND "source" = 'app';--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fx_ck" CHECK ("invoices"."legacy_sp_id" is not null or "invoices"."source" <> 'app' or ("invoices"."currency" = 'MKD' and "invoices"."exchange_rate" = 1 and "invoices"."fx_gross_total" is null) or ("invoices"."currency" <> 'MKD' and "invoices"."fx_gross_total" is not null));