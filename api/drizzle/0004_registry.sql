CREATE TYPE "public"."registry_kind" AS ENUM('lookup', 'client', 'partner');--> statement-breakpoint
CREATE TYPE "public"."registry_status" AS ENUM('pending', 'done', 'error');--> statement-breakpoint
CREATE TABLE "ujp_registry_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "registry_kind" NOT NULL,
	"edb" varchar(13) NOT NULL,
	"seller_edb" varchar(13) NOT NULL,
	"client_id" integer,
	"partner_id" integer,
	"status" "registry_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"requested_by" integer,
	"agent_key_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ujp_registry_requests" ADD CONSTRAINT "ujp_registry_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_registry_requests" ADD CONSTRAINT "ujp_registry_requests_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_registry_requests" ADD CONSTRAINT "ujp_registry_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ujp_registry_requests" ADD CONSTRAINT "ujp_registry_requests_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ujp_registry_pending_ix" ON "ujp_registry_requests" USING btree ("status","created_at");