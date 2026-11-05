CREATE TABLE "bank_statement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"statement_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"line_key" varchar(64) NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"value_date" date NOT NULL,
	"counterparty_name" text,
	"counterparty_account" varchar(40),
	"counterparty_edb" varchar(13),
	"payment_code" varchar(10),
	"purpose" text,
	"ref_debit" varchar(60),
	"ref_credit" varchar(60),
	"extra" varchar(60),
	"ignored" boolean DEFAULT false NOT NULL,
	"ignore_reason" varchar(200),
	"payment_id" integer,
	CONSTRAINT "bank_lines_amount_ck" CHECK ("bank_statement_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"format" varchar(10) NOT NULL,
	"own_account" varchar(40),
	"statement_no" varchar(20),
	"statement_date" date,
	"opening_balance" numeric(18, 2),
	"closing_balance" numeric(18, 2),
	"file_name" varchar(200),
	"file_hash" varchar(64) NOT NULL,
	"imported_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"account" varchar(40) NOT NULL,
	"source" varchar(10) DEFAULT 'learned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_accounts" ADD CONSTRAINT "partner_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_accounts" ADD CONSTRAINT "partner_accounts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_lines_key_uq" ON "bank_statement_lines" USING btree ("client_id","line_key");--> statement-breakpoint
CREATE INDEX "bank_lines_statement_ix" ON "bank_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_file_uq" ON "bank_statements" USING btree ("client_id","file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_no_uq" ON "bank_statements" USING btree ("client_id","own_account","statement_date","statement_no") WHERE "bank_statements"."own_account" is not null and "bank_statements"."statement_no" is not null;--> statement-breakpoint
CREATE INDEX "bank_statements_account_ix" ON "bank_statements" USING btree ("own_account");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_accounts_uq" ON "partner_accounts" USING btree ("client_id","account");--> statement-breakpoint
ALTER TABLE "partner_accounts" ADD CONSTRAINT "partner_accounts_partner_client_fk" FOREIGN KEY ("partner_id", "client_id") REFERENCES "partners"("id", "client_id");--> statement-breakpoint
-- postoeckite ziro-smetki od partnerite se prenesuvaat kako racni
INSERT INTO "partner_accounts" ("client_id", "partner_id", "account", "source")
  SELECT "client_id", "id", regexp_replace("bank_account", '[\s-]', '', 'g'), 'manual' FROM "partners"
  WHERE "bank_account" IS NOT NULL AND "bank_account" <> '' ON CONFLICT DO NOTHING;
