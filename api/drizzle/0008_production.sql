CREATE TYPE "public"."work_order_status" AS ENUM('draft', 'posted', 'voided');--> statement-breakpoint
ALTER TYPE "public"."stock_doc_kind" ADD VALUE 'consumption';--> statement-breakpoint
ALTER TYPE "public"."stock_doc_kind" ADD VALUE 'output';--> statement-breakpoint
CREATE TABLE "bom_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"bom_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" integer NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	"waste_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "bom_lines_qty_ck" CHECK ("bom_lines"."qty" > 0),
	CONSTRAINT "bom_lines_waste_ck" CHECK ("bom_lines"."waste_pct" >= 0 and "bom_lines"."waste_pct" < 100)
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"product_item_id" integer NOT NULL,
	"output_qty" numeric(18, 4) DEFAULT '1' NOT NULL,
	"labor_hours" numeric(18, 4) DEFAULT '0' NOT NULL,
	"labor_cost" numeric(18, 4),
	"note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boms_output_ck" CHECK ("boms"."output_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_order_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" integer NOT NULL,
	"planned_qty" numeric(18, 4) NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	CONSTRAINT "work_order_lines_qty_ck" CHECK ("work_order_lines"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"status" "work_order_status" DEFAULT 'draft' NOT NULL,
	"year" smallint NOT NULL,
	"seq_no" integer,
	"number" varchar(30),
	"product_item_id" integer NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	"doc_date" date NOT NULL,
	"warehouse_id" integer,
	"output_warehouse_id" integer,
	"labor_hours" numeric(18, 4),
	"labor_cost" numeric(18, 4),
	"overhead_cost" numeric(18, 4),
	"material_cost" numeric(18, 4),
	"total_cost" numeric(18, 4),
	"unit_cost" numeric(18, 4),
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" integer,
	"posted_by" integer,
	"posted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_orders_qty_ck" CHECK ("work_orders"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "production_settings" jsonb;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD COLUMN "work_order_id" integer;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_product_item_id_items_id_fk" FOREIGN KEY ("product_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_product_item_id_items_id_fk" FOREIGN KEY ("product_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_output_warehouse_id_warehouses_id_fk" FOREIGN KEY ("output_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bom_lines_no_uq" ON "bom_lines" USING btree ("bom_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "boms_product_uq" ON "boms" USING btree ("product_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_lines_no_uq" ON "work_order_lines" USING btree ("work_order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_seq_uq" ON "work_orders" USING btree ("client_id","year","seq_no");--> statement-breakpoint
CREATE INDEX "work_orders_client_ix" ON "work_orders" USING btree ("client_id","doc_date");--> statement-breakpoint
-- ===== integritet na proizvodstvoto (docs/07) =====
ALTER TABLE "boms" ADD CONSTRAINT "boms_product_client_fk" FOREIGN KEY ("product_item_id", "client_id") REFERENCES "items"("id", "client_id");--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_product_client_fk" FOREIGN KEY ("product_item_id", "client_id") REFERENCES "items"("id", "client_id");--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_wh_client_fk" FOREIGN KEY ("warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_out_wh_client_fk" FOREIGN KEY ("output_warehouse_id", "client_id") REFERENCES "warehouses"("id", "client_id");--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_work_order_fk" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id");--> statement-breakpoint
CREATE TRIGGER boms_updated_at BEFORE UPDATE ON "boms" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER work_orders_updated_at BEFORE UPDATE ON "work_orders" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
-- proknizen nalog ne se menuva (samo storniranje); ne se brise
CREATE OR REPLACE FUNCTION trg_work_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Прокнижен работен налог не смее да се брише (направете сторно).' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'voided' THEN RAISE EXCEPTION 'Сторниран работен налог не може да се менува.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'voided' OR (to_jsonb(NEW) - ARRAY['status','voided_at','void_reason','version','updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','voided_at','void_reason','version','updated_at']) THEN
      RAISE EXCEPTION 'Прокнижен работен налог не може да се менува (направете сторно).' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_orders_guard BEFORE UPDATE OR DELETE ON "work_orders" FOR EACH ROW EXECUTE FUNCTION trg_work_order_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_work_order_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wid integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.work_order_id ELSE NEW.work_order_id END;
  st work_order_status;
BEGIN
  SELECT status INTO st FROM work_orders WHERE id = wid;
  IF st IS NOT NULL AND st <> 'draft' THEN RAISE EXCEPTION 'Ставките на прокнижен работен налог не се менуваат.' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "work_order_lines" FOR EACH ROW EXECUTE FUNCTION trg_work_order_line_guard();
