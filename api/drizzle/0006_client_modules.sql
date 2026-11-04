ALTER TABLE "client_access" ADD COLUMN "modules" text[];--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "modules" text[] DEFAULT '{invoices,crm}'::text[] NOT NULL;--> statement-breakpoint
-- samo poznati moduli; osnovniot modul (invoices) e sekogas vklucen
ALTER TABLE "clients" ADD CONSTRAINT "clients_modules_ck" CHECK ("modules" <@ ARRAY['invoices','crm','payments','incoming','warehouse','production']::text[] AND 'invoices' = ANY("modules"));--> statement-breakpoint
ALTER TABLE "client_access" ADD CONSTRAINT "client_access_modules_ck" CHECK ("modules" IS NULL OR "modules" <@ ARRAY['invoices','crm','payments','incoming','warehouse','production']::text[]);
