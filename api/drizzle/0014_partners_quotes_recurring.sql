ALTER TYPE "public"."doc_type" ADD VALUE 'PF';--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"name" text NOT NULL,
	"lines" jsonb NOT NULL,
	"payment_method" "payment_method" DEFAULT 'bank' NOT NULL,
	"due_days" smallint,
	"note" text,
	"clauses" text,
	"warehouse_id" integer,
	"day_of_month" smallint NOT NULL,
	"next_date" date NOT NULL,
	"end_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_invoice_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_day_ck" CHECK ("recurring_invoices"."day_of_month" between 0 and 28)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "source_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recurring_id" integer;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "is_customer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "is_supplier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_source_invoice_id_invoices_id_fk" FOREIGN KEY ("source_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_client_ix" ON "recurring_invoices" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_invoice_fk" FOREIGN KEY ("source_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE no action;--> statement-breakpoint
-- ista povtoruvacka ne generira dve fakturi za ist datum (i pri paralelno startuvanje); otkazan nacrt NE se generira povtorno
CREATE UNIQUE INDEX "invoices_recurring_date_uq" ON "invoices" ("recurring_id", "issue_date") WHERE "recurring_id" is not null;--> statement-breakpoint
ALTER TABLE "clients" DROP CONSTRAINT "clients_modules_ck";--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_modules_ck" CHECK ("modules" <@ ARRAY['invoices','recurring','crm','payments','incoming','warehouse','production']::text[] AND 'invoices' = ANY("modules"));--> statement-breakpoint
ALTER TABLE "client_access" DROP CONSTRAINT "client_access_modules_ck";--> statement-breakpoint
ALTER TABLE "client_access" ADD CONSTRAINT "client_access_modules_ck" CHECK ("modules" IS NULL OR "modules" <@ ARRAY['invoices','recurring','crm','payments','incoming','warehouse','production']::text[]);--> statement-breakpoint
-- uloga od dosegasnata upotreba; partner bez nisto (vnesen racno kako kupuvac) -> kupuvac
UPDATE "partners" p SET "is_customer" = true WHERE EXISTS (SELECT 1 FROM "invoices" i WHERE i.partner_id = p.id);--> statement-breakpoint
UPDATE "partners" p SET "is_supplier" = true WHERE EXISTS (SELECT 1 FROM "purchase_invoices" x WHERE x.partner_id = p.id);--> statement-breakpoint
UPDATE "partners" SET "is_customer" = true WHERE NOT "is_customer" AND NOT "is_supplier";--> statement-breakpoint
CREATE INDEX "invoices_source_ix" ON "invoices" ("source_invoice_id") WHERE "source_invoice_id" is not null;
