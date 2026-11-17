CREATE TABLE "serial_moves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"serial_id" integer NOT NULL,
	"doc_id" integer NOT NULL,
	"move_id" bigint NOT NULL,
	"warehouse_id" integer NOT NULL,
	"qty" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serial_moves_qty_ck" CHECK ("serial_moves"."qty" in (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "serial_numbers" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"serial_no" varchar(100) NOT NULL,
	"warehouse_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "bank_lines_key_uq";--> statement-breakpoint
DROP INDEX "bank_statements_file_uq";--> statement-breakpoint
DROP INDEX "bank_statements_no_uq";--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "voided_by" integer;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "warranty_months" smallint;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "serials" text[];--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "track_serials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "warranty_months" smallint;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "short_name" varchar(100);--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD COLUMN "serials" text[];--> statement-breakpoint
ALTER TABLE "serial_moves" ADD CONSTRAINT "serial_moves_serial_id_serial_numbers_id_fk" FOREIGN KEY ("serial_id") REFERENCES "public"."serial_numbers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_moves" ADD CONSTRAINT "serial_moves_doc_id_stock_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."stock_docs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_moves" ADD CONSTRAINT "serial_moves_move_id_stock_moves_id_fk" FOREIGN KEY ("move_id") REFERENCES "public"."stock_moves"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_moves" ADD CONSTRAINT "serial_moves_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "serial_moves_serial_ix" ON "serial_moves" USING btree ("serial_id","id");--> statement-breakpoint
CREATE INDEX "serial_moves_move_ix" ON "serial_moves" USING btree ("move_id");--> statement-breakpoint
CREATE UNIQUE INDEX "serial_numbers_uq" ON "serial_numbers" USING btree ("client_id","item_id","serial_no");--> statement-breakpoint
CREATE INDEX "serial_numbers_no_ix" ON "serial_numbers" USING btree ("client_id","serial_no");--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_lines_key_uq" ON "bank_statement_lines" USING btree ("client_id","line_key") WHERE "bank_statement_lines"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_file_uq" ON "bank_statements" USING btree ("client_id","file_hash") WHERE "bank_statements"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_no_uq" ON "bank_statements" USING btree ("client_id","own_account","statement_date","statement_no") WHERE "bank_statements"."own_account" is not null and "bank_statements"."statement_no" is not null and "bank_statements"."voided_at" is null;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_lot_serial_ck" CHECK (not ("items"."track_lots" and "items"."track_serials"));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_warranty_ck" CHECK ("items"."warranty_months" is null or "items"."warranty_months" between 1 and 600);