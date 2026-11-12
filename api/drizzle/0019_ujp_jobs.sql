CREATE TYPE "public"."ujp_job_status" AS ENUM('queued', 'sending', 'sent', 'error', 'cancelled');--> statement-breakpoint
CREATE TABLE "ujp_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"status" "ujp_job_status" DEFAULT 'queued' NOT NULL,
	"queued_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"agent_key_id" integer,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "ujp_log" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "ujp_jobs" ADD CONSTRAINT "ujp_jobs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_jobs" ADD CONSTRAINT "ujp_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_jobs" ADD CONSTRAINT "ujp_jobs_queued_by_users_id_fk" FOREIGN KEY ("queued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_jobs" ADD CONSTRAINT "ujp_jobs_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ujp_jobs_status_ix" ON "ujp_jobs" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "ujp_jobs_invoice_ix" ON "ujp_jobs" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ujp_jobs_active_uq" ON "ujp_jobs" USING btree ("invoice_id") WHERE "ujp_jobs"."status" in ('queued', 'sending');