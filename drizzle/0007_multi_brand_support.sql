ALTER TABLE "scrape_requests" ADD COLUMN "brand_ids" text[];--> statement-breakpoint
UPDATE "scrape_requests" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "scrape_requests" DROP COLUMN IF EXISTS "brand_id";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_brand_ids" ON "scrape_requests" USING GIN ("brand_ids");
