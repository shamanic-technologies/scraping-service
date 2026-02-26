ALTER TABLE "scrape_requests" RENAME COLUMN "source_org_id" TO "org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_scrape_requests_source";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_source" ON "scrape_requests" USING btree ("source_service","org_id");