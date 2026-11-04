CREATE TYPE "public"."note_kind" AS ENUM('call', 'meeting', 'email', 'note');--> statement-breakpoint
CREATE TABLE "partner_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"role" varchar(120),
	"phone" varchar(50),
	"mobile" varchar(50),
	"email" varchar(254),
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"contact_id" integer,
	"kind" "note_kind" DEFAULT 'note' NOT NULL,
	"text" text NOT NULL,
	"follow_up_at" date,
	"follow_up_done_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_contacts" ADD CONSTRAINT "partner_contacts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_notes" ADD CONSTRAINT "partner_notes_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_notes" ADD CONSTRAINT "partner_notes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_notes" ADD CONSTRAINT "partner_notes_contact_id_partner_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."partner_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_notes" ADD CONSTRAINT "partner_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_contacts_partner_ix" ON "partner_contacts" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_notes_partner_ix" ON "partner_notes" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE INDEX "partner_notes_followup_ix" ON "partner_notes" USING btree ("client_id","follow_up_at") WHERE "partner_notes"."follow_up_at" is not null and "partner_notes"."follow_up_done_at" is null;--> statement-breakpoint
CREATE TRIGGER partner_contacts_updated_at BEFORE UPDATE ON "partner_contacts" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
-- istorijata: tekstot ne se menuva i zapisot ne se brise; dozvoleno e samo zatvoranje na potsetnikot
CREATE OR REPLACE FUNCTION trg_partner_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Записите во историјата не се бришат.' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'follow_up_done_at') IS DISTINCT FROM (to_jsonb(OLD) - 'follow_up_done_at') THEN
    RAISE EXCEPTION 'Записите во историјата не се менуваат (додадете нов запис).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER partner_notes_guard BEFORE UPDATE OR DELETE ON "partner_notes" FOR EACH ROW EXECUTE FUNCTION trg_partner_note_guard();
