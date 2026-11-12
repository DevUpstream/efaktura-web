CREATE TYPE "public"."cost_center_mode" AS ENUM('off', 'optional', 'required');--> statement-breakpoint
CREATE TABLE "cost_centers" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(120) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "cost_center_mode" "cost_center_mode" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "cost_center_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "cost_center_id" integer;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "cost_center_id" integer;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD COLUMN "cost_center_id" integer;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_centers_code_uq" ON "cost_centers" USING btree ("client_id",upper("code"));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_cost_center_ix" ON "invoices" USING btree ("client_id","cost_center_id") WHERE "invoices"."cost_center_id" is not null;--> statement-breakpoint
CREATE INDEX "purchases_cost_center_ix" ON "purchase_invoices" USING btree ("client_id","cost_center_id") WHERE "purchase_invoices"."cost_center_id" is not null;--> statement-breakpoint
-- Издадена фактура: дозволена е и промена на трошковно место (docs/14), сè друго останува заклучено.
CREATE OR REPLACE FUNCTION trg_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editable  CONSTANT invoice_status[] := ARRAY['draft','to_issue']::invoice_status[];
  allowed   CONSTANT text[] := ARRAY['status','status_message','ujp_id','ujp_timestamp','ujp_qr_link',
                                      'ujp_status_code','ujp_status_name','ujp_sent_at','ujp_error',
                                      'pdf_file_id','json_file_id','updated_at','version','cost_center_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('draft','cancelled_draft') AND OLD.seq_no IS NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Фактура % (%) не смее да се брише: издадена фактура се сторнира или коригира.',
      coalesce(OLD.number, OLD.id::text), OLD.status USING ERRCODE = 'P0001';
  END IF;

  NEW.updated_at := now();
  IF OLD.status = ANY (editable) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled_draft' THEN
    RAISE EXCEPTION 'Откажан нацрт не може да се менува.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = ANY (editable) OR NEW.status = 'cancelled_draft' THEN
    RAISE EXCEPTION 'Издадена фактура % не може да се врати во нацрт.', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Издадена фактура % не може да се менува (дозволени се само статус, податоци од УЈП и трошковно место).',
      OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_id integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  st invoice_status;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = inv_id;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'Ставка не може да се премести на друга фактура.' USING ERRCODE = 'P0001';
  END IF;
  -- trosковno mesto na stavka smee i po izdavanje (docs/14)
  IF TG_OP = 'UPDATE' AND st IS NOT NULL AND st <> 'draft' AND st <> 'cancelled_draft'
     AND (to_jsonb(NEW) - 'cost_center_id') = (to_jsonb(OLD) - 'cost_center_id') THEN
    RETURN NEW;
  END IF;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Ставките на фактура % не можат да се менуваат (статус %).', inv_id, st USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
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
    -- trosковno mesto smee (docs/14)
    IF NEW.status = 'posted' AND (to_jsonb(NEW) - ARRAY['cost_center_id','version','updated_at'])
         = (to_jsonb(OLD) - ARRAY['cost_center_id','version','updated_at']) THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'voided' OR (to_jsonb(NEW) - ARRAY['status','voided_at','void_reason','version','updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','voided_at','void_reason','version','updated_at']) THEN
      RAISE EXCEPTION 'Прокнижена влезна фактура не може да се менува (направете сторно).' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_purchase_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pid integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_invoice_id ELSE NEW.purchase_invoice_id END;
  st purchase_status;
BEGIN
  SELECT status INTO st FROM purchase_invoices WHERE id = pid;
  IF TG_OP = 'UPDATE' AND st = 'posted' AND (to_jsonb(NEW) - 'cost_center_id') = (to_jsonb(OLD) - 'cost_center_id') THEN
    RETURN NEW;   -- trosковno mesto (docs/14)
  END IF;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Ставките на прокнижена влезна фактура не се менуваат.' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
