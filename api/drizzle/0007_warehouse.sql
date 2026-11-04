CREATE TYPE "public"."negative_stock" AS ENUM('block', 'warn');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('draft', 'posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."stock_doc_kind" AS ENUM('receipt', 'issue', 'writeoff', 'inventory', 'transfer');--> statement-breakpoint
ALTER TYPE "public"."item_type" ADD VALUE 'material';--> statement-breakpoint
ALTER TYPE "public"."item_type" ADD VALUE 'product';--> statement-breakpoint
CREATE TABLE "lot_balances" (
	"lot_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "lot_balances_lot_id_warehouse_id_pk" PRIMARY KEY("lot_id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"lot_no" varchar(50) NOT NULL,
	"expiry_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"warehouse_id" integer,
	"status" "purchase_status" DEFAULT 'draft' NOT NULL,
	"year" smallint NOT NULL,
	"seq_no" integer,
	"number" varchar(30),
	"supplier_number" varchar(60) NOT NULL,
	"issue_date" date NOT NULL,
	"received_date" date NOT NULL,
	"due_date" date,
	"net_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"vat_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"gross_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" integer,
	"posted_by" integer,
	"posted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_invoice_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" integer,
	"description" text NOT NULL,
	"unit" varchar(10) NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"vat_rate_id" integer NOT NULL,
	"vat_rate_pct" numeric(5, 2) NOT NULL,
	"net_amount" numeric(18, 4) NOT NULL,
	"vat_amount" numeric(18, 4) NOT NULL,
	"allocate" boolean DEFAULT false NOT NULL,
	"lot_no" varchar(50),
	"expiry_date" date,
	"unit_cost" numeric(18, 4),
	CONSTRAINT "purchase_lines_qty_ck" CHECK ("purchase_lines"."qty" > 0),
	CONSTRAINT "purchase_lines_price_ck" CHECK ("purchase_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"warehouse_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"last_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "stock_balances_warehouse_id_item_id_pk" PRIMARY KEY("warehouse_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "stock_counters" (
	"client_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"year" smallint NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stock_counters_client_id_kind_year_pk" PRIMARY KEY("client_id","kind","year")
);
--> statement-breakpoint
CREATE TABLE "stock_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"kind" "stock_doc_kind" NOT NULL,
	"warehouse_id" integer NOT NULL,
	"to_warehouse_id" integer,
	"year" smallint NOT NULL,
	"seq_no" integer NOT NULL,
	"number" varchar(30) NOT NULL,
	"doc_date" date NOT NULL,
	"purchase_invoice_id" integer,
	"invoice_id" integer,
	"reverses_doc_id" integer,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_moves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"doc_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"lot_id" integer,
	"qty" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"balance_qty" numeric(18, 4) NOT NULL,
	"balance_value" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_moves_qty_ck" CHECK ("stock_moves"."qty" <> 0)
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "negative_stock" "negative_stock" DEFAULT 'block' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "warehouse_id" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "track_lots" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lot_balances" ADD CONSTRAINT "lot_balances_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_balances" ADD CONSTRAINT "lot_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_vat_rate_id_vat_rates_id_fk" FOREIGN KEY ("vat_rate_id") REFERENCES "public"."vat_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counters" ADD CONSTRAINT "stock_counters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_doc_id_stock_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."stock_docs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lots_item_no_uq" ON "lots" USING btree ("item_id","lot_no");--> statement-breakpoint
CREATE INDEX "purchase_client_ix" ON "purchase_invoices" USING btree ("client_id","received_date");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_seq_uq" ON "purchase_invoices" USING btree ("client_id","year","seq_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_supplier_no_uq" ON "purchase_invoices" USING btree ("client_id","partner_id","supplier_number") WHERE "purchase_invoices"."status" <> 'voided';--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_lines_no_uq" ON "purchase_lines" USING btree ("purchase_invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_balances_client_ix" ON "stock_balances" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_docs_seq_uq" ON "stock_docs" USING btree ("client_id","kind","year","seq_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_docs_reverses_uq" ON "stock_docs" USING btree ("reverses_doc_id") WHERE "stock_docs"."reverses_doc_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_docs_client_ix" ON "stock_docs" USING btree ("client_id","doc_date");--> statement-breakpoint
CREATE INDEX "stock_docs_invoice_ix" ON "stock_docs" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "stock_moves_card_ix" ON "stock_moves" USING btree ("warehouse_id","item_id","id");--> statement-breakpoint
CREATE INDEX "stock_moves_doc_ix" ON "stock_moves" USING btree ("doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_client_code_uq" ON "warehouses" USING btree ("client_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_id_client_uq" ON "warehouses" USING btree ("id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_default_uq" ON "warehouses" USING btree ("client_id") WHERE "warehouses"."is_default";--> statement-breakpoint
-- ===== integritet na magacinot (docs/07) =====
-- izolacija po klient: dobavuvac, magacin i artikl od istiot klient
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_partner_client_fk" FOREIGN KEY ("partner_id", "client_id") REFERENCES "partners"("id", "client_id");--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_warehouse_client_fk" FOREIGN KEY ("warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_client_fk" FOREIGN KEY ("warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_warehouse_client_fk" FOREIGN KEY ("warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_to_warehouse_client_fk" FOREIGN KEY ("to_warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_item_client_fk" FOREIGN KEY ("item_id", "client_id") REFERENCES "items"("id", "client_id");--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_warehouse_client_fk" FOREIGN KEY ("warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_reverses_fk" FOREIGN KEY ("reverses_doc_id") REFERENCES "stock_docs"("id");--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_code_ck" CHECK ("code" ~ '^[A-Z0-9]{1,10}$');--> statement-breakpoint

-- sekoj klient ima glaven magacin (postoeckite i novite)
INSERT INTO "warehouses" ("client_id", "code", "name", "is_default") SELECT "id", 'GL', 'Главен магацин', true FROM "clients";--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_client_default_warehouse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO warehouses (client_id, code, name, is_default) VALUES (NEW.id, 'GL', 'Главен магацин', true);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER clients_default_warehouse AFTER INSERT ON "clients" FOR EACH ROW EXECUTE FUNCTION trg_client_default_warehouse();
--> statement-breakpoint

-- magacinskite dokumenti i dvizenja ne se menuvaat i ne se brisat
CREATE TRIGGER stock_docs_append_only BEFORE UPDATE OR DELETE ON "stock_docs" FOR EACH ROW EXECUTE FUNCTION trg_append_only();
--> statement-breakpoint
CREATE TRIGGER stock_moves_append_only BEFORE UPDATE OR DELETE ON "stock_moves" FOR EACH ROW EXECUTE FUNCTION trg_append_only();
--> statement-breakpoint

-- vlezna faktura: proknizena ne se menuva (dozvoleno samo storniranje); ne se brise
CREATE OR REPLACE FUNCTION trg_purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Прокнижена влезна фактура не смее да се брише (направете сторно).' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'Сторнирана влезна фактура не може да се менува.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'voided' OR (to_jsonb(NEW) - ARRAY['status','voided_at','void_reason','version','updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','voided_at','void_reason','version','updated_at']) THEN
      RAISE EXCEPTION 'Прокнижена влезна фактура не може да се менува (направете сторно).' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_invoices_guard BEFORE UPDATE OR DELETE ON "purchase_invoices" FOR EACH ROW EXECUTE FUNCTION trg_purchase_guard();
--> statement-breakpoint
CREATE TRIGGER purchase_invoices_updated_at BEFORE UPDATE ON "purchase_invoices" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_purchase_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pid integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_invoice_id ELSE NEW.purchase_invoice_id END;
  st purchase_status;
BEGIN
  SELECT status INTO st FROM purchase_invoices WHERE id = pid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    -- dozvoleno: zapis na presmetanata nabavna cena pri samoto knizenje (status vekje 'posted' vo istata transakcija ne e)
    RAISE EXCEPTION 'Ставките на прокнижена влезна фактура не се менуваат.' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "purchase_lines" FOR EACH ROW EXECUTE FUNCTION trg_purchase_line_guard();
