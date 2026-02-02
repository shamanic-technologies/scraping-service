CREATE TABLE IF NOT EXISTS "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_clerk_org_id_unique" UNIQUE("clerk_org_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scrape_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_url" text NOT NULL,
	"result_id" uuid NOT NULL,
	"company_name" text,
	"industry" text,
	"is_valid" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrape_cache_normalized_url_unique" UNIQUE("normalized_url")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scrape_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_service" text NOT NULL,
	"source_org_id" text NOT NULL,
	"source_ref_id" text,
	"url" text NOT NULL,
	"options" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scrape_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"company_name" text,
	"description" text,
	"industry" text,
	"employee_count" text,
	"founded_year" integer,
	"headquarters" text,
	"website" text,
	"email" text,
	"phone" text,
	"linkedin_url" text,
	"twitter_url" text,
	"products" jsonb,
	"services" jsonb,
	"raw_markdown" text,
	"raw_metadata" jsonb,
	"firecrawl_job_id" text,
	"firecrawl_credits_used" integer,
	"extraction_model" text,
	"extraction_tokens" integer,
	"extraction_cost_usd" numeric(10, 6),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks_runs_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_run_id" uuid NOT NULL,
	"cost_name" text NOT NULL,
	"units" integer NOT NULL,
	"cost_per_unit_in_usd_cents" numeric(12, 10) NOT NULL,
	"total_cost_in_usd_cents" numeric(12, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scrape_cache" ADD CONSTRAINT "scrape_cache_result_id_scrape_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."scrape_results"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scrape_results" ADD CONSTRAINT "scrape_results_request_id_scrape_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."scrape_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks_runs" ADD CONSTRAINT "tasks_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks_runs" ADD CONSTRAINT "tasks_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks_runs" ADD CONSTRAINT "tasks_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks_runs_costs" ADD CONSTRAINT "tasks_runs_costs_task_run_id_tasks_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."tasks_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_clerk_id" ON "orgs" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cache_normalized_url" ON "scrape_cache" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cache_expires" ON "scrape_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_source" ON "scrape_requests" USING btree ("source_service","source_org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_url" ON "scrape_requests" USING btree ("url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_requests_status" ON "scrape_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_scrape_results_normalized_url" ON "scrape_results" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_results_request" ON "scrape_results" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scrape_results_expires" ON "scrape_results" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_task" ON "tasks_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_org" ON "tasks_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_status" ON "tasks_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_costs_run" ON "tasks_runs_costs" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_costs_name" ON "tasks_runs_costs" USING btree ("cost_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_clerk_id" ON "users" USING btree ("clerk_user_id");