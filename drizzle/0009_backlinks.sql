CREATE TABLE IF NOT EXISTS "backlink_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_id" text NOT NULL,
	"campaign_id" text,
	"provider" text NOT NULL,
	"brand_domain" text,
	"window_start" timestamp with time zone,
	"status" text NOT NULL,
	"error_code" text,
	"answer" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_backlink_checks_idem" ON "backlink_checks" USING btree ("org_id","brand_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_backlink_checks_brand" ON "backlink_checks" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_backlinks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"referring_domain" text NOT NULL,
	"referring_url" text NOT NULL,
	"target_url" text NOT NULL,
	"anchor" text,
	"dofollow" boolean,
	"domain_rank" integer,
	"spam_score" integer,
	"first_seen_at" timestamp with time zone,
	"provider" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"check_id" uuid NOT NULL,
	"declared_run_id" text,
	"declared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_brand_backlinks_domain" ON "brand_backlinks" USING btree ("org_id","brand_id","referring_domain");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "link_gap_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"competitors_key" text NOT NULL,
	"run_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"answer" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_link_gap_reports_idem" ON "link_gap_reports" USING btree ("org_id","brand_id","idempotency_key","competitors_key");
