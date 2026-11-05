ALTER TABLE "bank_statement_lines" ADD COLUMN "category" varchar(20);--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD COLUMN "category_source" varchar(10);--> statement-breakpoint
-- dosega "ne se knizi" -> vid "Не се книжи" (racno)
UPDATE "bank_statement_lines" SET "category" = 'skip', "category_source" = 'manual' WHERE "ignored" AND "category" IS NULL;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_lines_category_ck" CHECK ("category" IS NULL OR "category" IN ('fee','tax','card','salary','other','transfer','loan','skip'));--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_lines_category_ignored_ck" CHECK (("category" IS NULL) = (NOT "ignored"));
