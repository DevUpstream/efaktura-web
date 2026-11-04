CREATE TYPE "public"."token_purpose" AS ENUM('invite', 'reset');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" char(64) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"mfa_ok" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" varchar(45),
	"user_agent" varchar(300)
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id_hash" char(64) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"purpose" "token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_provider_ck";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_counter" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_ix" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_provider_ck" CHECK (("users"."provider" = 'entra' and "users"."password_hash" is null and "users"."totp_secret_enc" is null)
                              or ("users"."provider" = 'local' and "users"."entra_oid" is null));