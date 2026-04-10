ALTER TABLE "scrape_requests" ADD COLUMN "provider" text NOT NULL DEFAULT 'firecrawl';--> statement-breakpoint
ALTER TABLE "scrape_requests" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_brand_ids" ON "scrape_requests" USING gin ("brand_ids");
