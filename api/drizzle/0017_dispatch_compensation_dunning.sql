CREATE TABLE "compensations" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"year" smallint NOT NULL,
	"seq_no" integer NOT NULL,
	"number" varchar(30) NOT NULL,
	"doc_date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"in_payment_id" integer NOT NULL,
	"out_payment_id" integer NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "compensations_amount_ck" CHECK ("compensations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "dunning_letters" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"partner_id" integer NOT NULL,
	"doc_date" date NOT NULL,
	"level" smallint NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"items" jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dunning_level_ck" CHECK ("dunning_letters"."level" between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "stock_doc_id" integer;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD COLUMN "partner_id" integer;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_in_payment_id_payments_id_fk" FOREIGN KEY ("in_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_out_payment_id_payments_id_fk" FOREIGN KEY ("out_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_letters" ADD CONSTRAINT "dunning_letters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_letters" ADD CONSTRAINT "dunning_letters_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_letters" ADD CONSTRAINT "dunning_letters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compensations_seq_uq" ON "compensations" USING btree ("client_id","year","seq_no");--> statement-breakpoint
CREATE INDEX "compensations_partner_ix" ON "compensations" USING btree ("client_id","partner_id");--> statement-breakpoint
CREATE INDEX "dunning_partner_ix" ON "dunning_letters" USING btree ("client_id","partner_id","doc_date");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_stock_doc_id_stock_docs_id_fk" FOREIGN KEY ("stock_doc_id") REFERENCES "public"."stock_docs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD CONSTRAINT "stock_docs_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_stock_doc_ix" ON "invoice_lines" USING btree ("stock_doc_id") WHERE "invoice_lines"."stock_doc_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_docs_partner_ix" ON "stock_docs" USING btree ("client_id","partner_id") WHERE "stock_docs"."partner_id" is not null;