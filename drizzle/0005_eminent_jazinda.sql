CREATE TABLE IF NOT EXISTS "extract_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_url" text NOT NULL,
	"authors" jsonb,
	"published_at" text,
	"is_valid" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extract_cache_normalized_url_unique" UNIQUE("normalized_url")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_extract_cache_normalized_url" ON "extract_cache" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_extract_cache_expires" ON "extract_cache" USING btree ("expires_at");