CREATE TABLE "purchase_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_invoice_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"data" bytea NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_item_map" (
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"desc_key" text NOT NULL,
	"item_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_item_map_client_id_partner_id_desc_key_pk" PRIMARY KEY("client_id","partner_id","desc_key")
);
--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "source" varchar(12) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "fixed_amounts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "payable_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "turnover_date" date;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "ujp_doc_type" varchar(3);--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "source_json" jsonb;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "source_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "purchase_files" ADD CONSTRAINT "purchase_files_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_files" ADD CONSTRAINT "purchase_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_item_map" ADD CONSTRAINT "supplier_item_map_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_item_map" ADD CONSTRAINT "supplier_item_map_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_item_map" ADD CONSTRAINT "supplier_item_map_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_files_purchase_ix" ON "purchase_files" USING btree ("purchase_invoice_id");--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_source_ck" CHECK ("source" in ('manual', 'ujp_json'));--> statement-breakpoint
CREATE INDEX "purchase_source_hash_ix" ON "purchase_invoices" USING btree ("client_id", "source_hash") WHERE "source_hash" is not null;--> statement-breakpoint
-- prilog na proknizena / stornirana vlezna faktura ne se brise
CREATE OR REPLACE FUNCTION trg_purchase_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st purchase_status;
BEGIN
  SELECT status INTO st FROM purchase_invoices WHERE id = OLD.purchase_invoice_id;
  IF TG_OP = 'UPDATE' OR (st IS NOT NULL AND st <> 'draft') THEN
    RAISE EXCEPTION 'Прилогот на прокнижена влезна фактура не се менува и не се брише.' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_files_guard BEFORE UPDATE OR DELETE ON "purchase_files" FOR EACH ROW EXECUTE FUNCTION trg_purchase_file_guard();
