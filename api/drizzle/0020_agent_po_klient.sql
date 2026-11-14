ALTER TABLE "agent_keys" ADD COLUMN "client_ids" integer[];--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "agent_version" varchar(20);--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "agent_info" jsonb;