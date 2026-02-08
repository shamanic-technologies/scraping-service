DROP TABLE "orgs" CASCADE;--> statement-breakpoint
DROP TABLE "tasks" CASCADE;--> statement-breakpoint
DROP TABLE "tasks_runs" CASCADE;--> statement-breakpoint
DROP TABLE "tasks_runs_costs" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
ALTER TABLE "scrape_requests" ADD COLUMN "run_id" text;