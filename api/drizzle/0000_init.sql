CREATE TYPE "public"."auth_provider" AS ENUM('entra', 'local');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('INV', 'AV', 'OD', 'KZ', 'ST', 'KR');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('pdf', 'json', 'ujp_response', 'logo');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'to_issue', 'issued', 'json_exported', 'sent_to_ujp', 'rejected', 'voided', 'corrected', 'cancelled_draft');--> statement-breakpoint
CREATE TYPE "public"."item_type" AS ENUM('goods', 'service');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank', 'cash', 'card', 'compensation', 'other');--> statement-breakpoint
CREATE TYPE "public"."reason_kind" AS ENUM('void', 'correction');--> statement-breakpoint
CREATE TYPE "public"."ujp_action" AS ENUM('send', 'status', 'dry-run');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'accountant');--> statement-breakpoint
CREATE TYPE "public"."vat_group" AS ENUM('DDV-A', 'DDV-B', 'DDV-V', 'DDV-G');--> statement-breakpoint
CREATE TYPE "public"."vat_impact" AS ENUM('STANDARD', 'NULA', 'OSLOBODEN', 'PRENESEN');--> statement-breakpoint
CREATE TABLE "agent_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"key_hash" char(64) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer,
	"agent_key_id" integer,
	"client_id" integer,
	"entity" varchar(40) NOT NULL,
	"entity_id" text NOT NULL,
	"action" varchar(40) NOT NULL,
	"changes" jsonb,
	"ip" varchar(45)
);
--> statement-breakpoint
CREATE TABLE "client_access" (
	"client_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_access_client_id_user_id_pk" PRIMARY KEY("client_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"name" text NOT NULL,
	"edb" varchar(13) NOT NULL,
	"embs" varchar(8),
	"vat_number" varchar(20),
	"vat_payer" boolean DEFAULT false NOT NULL,
	"address" text NOT NULL,
	"city" text NOT NULL,
	"postal_code" varchar(10),
	"country" char(2) DEFAULT 'MK' NOT NULL,
	"iban" varchar(34),
	"bank_name" text,
	"email" varchar(254),
	"phone" varchar(50),
	"invoice_prefix" varchar(10) NOT NULL,
	"invoice_clauses" text,
	"logo_file_id" uuid,
	"ujp_registry_at" timestamp with time zone,
	"ujp_registry_note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_legacy_sp_id_unique" UNIQUE("legacy_sp_id"),
	CONSTRAINT "clients_edb_unique" UNIQUE("edb"),
	CONSTRAINT "clients_invoice_prefix_unique" UNIQUE("invoice_prefix"),
	CONSTRAINT "clients_edb_ck" CHECK ("clients"."edb" ~ '^[0-9]{13}$'),
	CONSTRAINT "clients_prefix_ck" CHECK ("clients"."invoice_prefix" ~ '^[A-Z0-9]{1,10}$')
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"client_id" integer NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"year" smallint NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "counters_client_id_doc_type_year_pk" PRIMARY KEY("client_id","doc_type","year")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" integer NOT NULL,
	"invoice_id" integer,
	"kind" "file_kind" NOT NULL,
	"file_name" text NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_path" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"invoice_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" integer,
	"description" text NOT NULL,
	"unit" varchar(10) NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"vat_rate_id" integer NOT NULL,
	"vat_rate_pct" numeric(5, 2) NOT NULL,
	"net_amount" numeric(18, 4) NOT NULL,
	"vat_amount" numeric(18, 4) NOT NULL,
	"price_source" varchar(80),
	CONSTRAINT "invoice_lines_legacy_sp_id_unique" UNIQUE("legacy_sp_id"),
	CONSTRAINT "invoice_lines_discount_ck" CHECK ("invoice_lines"."discount_pct" >= 0 and "invoice_lines"."discount_pct" <= 100),
	CONSTRAINT "invoice_lines_price_ck" CHECK ("invoice_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"doc_type" "doc_type" DEFAULT 'INV' NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"year" smallint NOT NULL,
	"seq_no" integer,
	"number" varchar(40),
	"issue_date" date NOT NULL,
	"supply_date" date,
	"due_date" date,
	"currency" char(3) DEFAULT 'MKD' NOT NULL,
	"exchange_rate" numeric(18, 6) DEFAULT '1' NOT NULL,
	"payment_method" "payment_method" DEFAULT 'bank' NOT NULL,
	"net_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"vat_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"gross_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"advance_invoice_id" integer,
	"advance_amount" numeric(18, 2),
	"payable_amount" numeric(18, 2),
	"related_invoice_id" integer,
	"correction_reason" text,
	"void_reason_code" varchar(10),
	"correction_reason_code" varchar(10),
	"clauses" text,
	"note" text,
	"buyer_name" text,
	"buyer_edb" varchar(13),
	"buyer_vat_number" varchar(20),
	"buyer_address" text,
	"buyer_city" text,
	"buyer_country" char(2),
	"seller_name" text,
	"seller_edb" varchar(13),
	"seller_vat_number" varchar(20),
	"seller_address" text,
	"seller_city" text,
	"seller_iban" varchar(34),
	"seller_bank" text,
	"issued_by" integer,
	"issued_at" timestamp with time zone,
	"status_message" text,
	"ujp_id" varchar(40),
	"ujp_timestamp" timestamp with time zone,
	"ujp_qr_link" varchar(255),
	"ujp_status_code" varchar(5),
	"ujp_status_name" varchar(60),
	"ujp_sent_at" timestamp with time zone,
	"ujp_error" text,
	"pdf_file_id" uuid,
	"json_file_id" uuid,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoices_legacy_sp_id_unique" UNIQUE("legacy_sp_id"),
	CONSTRAINT "invoices_issued_has_number_ck" CHECK ("invoices"."status" in ('draft','to_issue','cancelled_draft') or ("invoices"."seq_no" is not null and "invoices"."number" is not null)),
	CONSTRAINT "invoices_supply_ck" CHECK ("invoices"."doc_type" = 'AV' or "invoices"."status" in ('draft','cancelled_draft') or "invoices"."supply_date" is not null),
	CONSTRAINT "invoices_rate_ck" CHECK ("invoices"."exchange_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"client_id" integer NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"type" "item_type" DEFAULT 'service' NOT NULL,
	"unit" varchar(10) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"vat_rate_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_legacy_sp_id_unique" UNIQUE("legacy_sp_id"),
	CONSTRAINT "items_price_ck" CHECK ("items"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "partner_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date DEFAULT '2099-12-31' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_prices_legacy_sp_id_unique" UNIQUE("legacy_sp_id"),
	CONSTRAINT "partner_prices_price_ck" CHECK ("partner_prices"."price" >= 0),
	CONSTRAINT "partner_prices_period_ck" CHECK ("partner_prices"."valid_to" >= "partner_prices"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"edb" varchar(13),
	"embs" varchar(8),
	"vat_number" varchar(20),
	"address" text,
	"city" text,
	"postal_code" varchar(10),
	"country" char(2) DEFAULT 'MK' NOT NULL,
	"email" varchar(254),
	"phone" varchar(50),
	"ujp_registry_at" timestamp with time zone,
	"ujp_registry_note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_legacy_sp_id_unique" UNIQUE("legacy_sp_id")
);
--> statement-breakpoint
CREATE TABLE "ujp_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"invoice_id" integer,
	"client_id" integer,
	"action" "ujp_action" NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"http_status" smallint,
	"euid" varchar(40),
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ujp_reasons" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "reason_kind" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(254) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"entra_oid" uuid,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"role" "user_role" DEFAULT 'accountant' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_logins" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_provider_ck" CHECK (("users"."provider" = 'entra' and "users"."entra_oid" is not null)
                              or ("users"."provider" = 'local' and "users"."password_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "vat_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_sp_id" integer,
	"code" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"ujp_code" varchar(20),
	"vat_group" "vat_group",
	"vat_impact" "vat_impact",
	"rate_pct" numeric(5, 2) NOT NULL,
	"is_exempt" boolean DEFAULT false NOT NULL,
	"legal_basis" text,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "vat_rates_legacy_sp_id_unique" UNIQUE("legacy_sp_id"),
	CONSTRAINT "vat_rates_code_unique" UNIQUE("code"),
	CONSTRAINT "vat_rates_pct_ck" CHECK ("vat_rates"."rate_pct" >= 0 and "vat_rates"."rate_pct" <= 100)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access" ADD CONSTRAINT "client_access_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access" ADD CONSTRAINT "client_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_vat_rate_id_vat_rates_id_fk" FOREIGN KEY ("vat_rate_id") REFERENCES "public"."vat_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_void_reason_code_ujp_reasons_code_fk" FOREIGN KEY ("void_reason_code") REFERENCES "public"."ujp_reasons"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_correction_reason_code_ujp_reasons_code_fk" FOREIGN KEY ("correction_reason_code") REFERENCES "public"."ujp_reasons"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_vat_rate_id_vat_rates_id_fk" FOREIGN KEY ("vat_rate_id") REFERENCES "public"."vat_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prices" ADD CONSTRAINT "partner_prices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prices" ADD CONSTRAINT "partner_prices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prices" ADD CONSTRAINT "partner_prices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_log" ADD CONSTRAINT "ujp_log_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_log" ADD CONSTRAINT "ujp_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_ix" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_client_ix" ON "audit_log" USING btree ("client_id","at");--> statement-breakpoint
CREATE INDEX "client_access_user_ix" ON "client_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "files_invoice_ix" ON "files" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_no_uq" ON "invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "invoice_lines_item_ix" ON "invoice_lines" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "invoices_client_year_ix" ON "invoices" USING btree ("client_id","year","status");--> statement-breakpoint
CREATE INDEX "invoices_partner_ix" ON "invoices" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "invoices_related_ix" ON "invoices" USING btree ("related_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_ujp_pending_ix" ON "invoices" USING btree ("status") WHERE "invoices"."status" = 'issued' and "invoices"."ujp_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_seq_uq" ON "invoices" USING btree ("client_id","doc_type","year","seq_no") WHERE "invoices"."seq_no" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("client_id","number") WHERE "invoices"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_ujp_id_uq" ON "invoices" USING btree ("ujp_id") WHERE "invoices"."ujp_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "items_client_code_uq" ON "items" USING btree ("client_id","code");--> statement-breakpoint
CREATE INDEX "partner_prices_lookup_ix" ON "partner_prices" USING btree ("client_id","partner_id","item_id","valid_from");--> statement-breakpoint
CREATE INDEX "partners_client_ix" ON "partners" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partners_client_edb_uq" ON "partners" USING btree ("client_id","edb") WHERE "partners"."edb" is not null;--> statement-breakpoint
CREATE INDEX "ujp_log_invoice_ix" ON "ujp_log" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_uq" ON "users" USING btree ("entra_oid") WHERE "users"."entra_oid" is not null;