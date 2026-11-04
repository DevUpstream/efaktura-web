CREATE TYPE "public"."payment_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_id" integer NOT NULL,
	"invoice_id" integer,
	"purchase_invoice_id" integer,
	"amount" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_alloc_amount_ck" CHECK ("payment_allocations"."amount" > 0),
	CONSTRAINT "payment_alloc_target_ck" CHECK (("payment_allocations"."invoice_id" is null) <> ("payment_allocations"."purchase_invoice_id" is null))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"partner_id" integer NOT NULL,
	"pay_date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"method" "payment_method" DEFAULT 'bank' NOT NULL,
	"reference" varchar(200),
	"statement_line_key" varchar(64),
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" integer,
	"void_reason" text,
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "bank_import_mapping" jsonb;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "bank_account" varchar(40);--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_alloc_payment_ix" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_alloc_invoice_ix" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_alloc_purchase_ix" ON "payment_allocations" USING btree ("purchase_invoice_id");--> statement-breakpoint
CREATE INDEX "payments_client_ix" ON "payments" USING btree ("client_id","pay_date");--> statement-breakpoint
CREATE INDEX "payments_partner_ix" ON "payments" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_statement_uq" ON "payments" USING btree ("client_id","statement_line_key") WHERE "payments"."statement_line_key" is not null and "payments"."voided_at" is null;--> statement-breakpoint
-- ===== integritet na plakjanjata (docs/08) =====
ALTER TABLE "payments" ADD CONSTRAINT "payments_partner_client_fk" FOREIGN KEY ("partner_id", "client_id") REFERENCES "partners"("id", "client_id");--> statement-breakpoint
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON "payment_allocations" FOR EACH ROW EXECUTE FUNCTION trg_append_only();
--> statement-breakpoint
-- uplata: ne se brise; se menuva samo storniranjeto (ednash)
CREATE OR REPLACE FUNCTION trg_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Уплатата не смее да се брише (направете сторно).' USING ERRCODE = 'P0001'; END IF;
  IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'Сторнирана уплата не може да се менува.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.voided_at IS NULL OR (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
    RAISE EXCEPTION 'Уплатата не може да се менува (направете сторно).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION trg_payment_guard();
