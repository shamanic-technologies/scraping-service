ALTER TABLE "scrape_requests" ADD COLUMN IF NOT EXISTS "outcome_key" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_org_created" ON "scrape_requests" USING btree ("org_id","created_at" DESC);--> statement-breakpoint
UPDATE "scrape_requests" SET "outcome_key" = 'company_researched' WHERE "outcome_key" IS NULL AND "status" = 'completed' AND "source_service" = 'workflow-service' AND "workflow_slug" LIKE 'sales-cold-email-outreach%';
