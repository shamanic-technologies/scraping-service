DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scrape_requests' AND column_name = 'provider'
  ) THEN
    ALTER TABLE "scrape_requests" ADD COLUMN "provider" text NOT NULL DEFAULT 'firecrawl';
    ALTER TABLE "scrape_requests" ALTER COLUMN "provider" DROP DEFAULT;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_brand_ids" ON "scrape_requests" USING gin ("brand_ids");
