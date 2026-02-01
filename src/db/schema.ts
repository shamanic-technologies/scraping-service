import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  numeric,
  uniqueIndex,
  index,
  decimal,
} from "drizzle-orm/pg-core";

/**
 * Scrape requests - records of scraping requests
 */
export const scrapeRequests = pgTable(
  "scrape_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Source identification (which project/service sent this)
    sourceService: text("source_service").notNull(), // 'mcpfactory', 'pressbeat', etc.
    sourceOrgId: text("source_org_id").notNull(), // Clerk org ID
    sourceRefId: text("source_ref_id"), // Campaign ID, pitch ID, etc.

    // Request details
    url: text("url").notNull(),
    options: jsonb("options"), // { formats: ['markdown'], ... }

    // Status tracking
    status: text("status").notNull().default("pending"), // 'pending', 'processing', 'completed', 'failed'
    errorMessage: text("error_message"),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_scrape_requests_source").on(table.sourceService, table.sourceOrgId),
    index("idx_scrape_requests_url").on(table.url),
    index("idx_scrape_requests_status").on(table.status),
  ]
);

/**
 * Scrape results - extracted company information
 * Cached to avoid re-scraping the same URL
 */
export const scrapeResults = pgTable(
  "scrape_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => scrapeRequests.id, { onDelete: "cascade" }),

    // URL that was scraped
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(), // URL without trailing slash, www, etc.

    // Extracted company info
    companyName: text("company_name"),
    description: text("description"),
    industry: text("industry"),
    employeeCount: text("employee_count"), // '1-10', '11-50', etc.
    foundedYear: integer("founded_year"),
    headquarters: text("headquarters"),
    website: text("website"),

    // Contact info
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    twitterUrl: text("twitter_url"),

    // Products/services
    products: jsonb("products"), // Array of product names/descriptions
    services: jsonb("services"), // Array of service offerings

    // Raw content
    rawMarkdown: text("raw_markdown"), // Full page content in markdown
    rawMetadata: jsonb("raw_metadata"), // Title, meta tags, etc.

    // Firecrawl response info
    firecrawlJobId: text("firecrawl_job_id"),
    firecrawlCreditsUsed: integer("firecrawl_credits_used"),

    // AI extraction info (if we use AI to extract structured data)
    extractionModel: text("extraction_model"),
    extractionTokens: integer("extraction_tokens"),
    extractionCostUsd: decimal("extraction_cost_usd", { precision: 10, scale: 6 }),

    // Cache control
    expiresAt: timestamp("expires_at", { withTimezone: true }), // When to re-scrape

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_scrape_results_normalized_url").on(table.normalizedUrl),
    index("idx_scrape_results_request").on(table.requestId),
    index("idx_scrape_results_expires").on(table.expiresAt),
  ]
);

/**
 * Scrape cache - quick lookup for cached results
 * Separate table to allow fast cache checks without loading full results
 */
export const scrapeCache = pgTable(
  "scrape_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedUrl: text("normalized_url").notNull().unique(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => scrapeResults.id, { onDelete: "cascade" }),
    
    // Quick access fields
    companyName: text("company_name"),
    industry: text("industry"),
    
    // Cache validity
    isValid: boolean("is_valid").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cache_normalized_url").on(table.normalizedUrl),
    index("idx_cache_expires").on(table.expiresAt),
  ]
);


// Local users table (maps to Clerk)
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_clerk_id").on(table.clerkUserId),
  ]
);

// Local orgs table (maps to Clerk)
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkOrgId: text("clerk_org_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_clerk_id").on(table.clerkOrgId),
  ]
);

// Task type registry
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// Task runs (individual executions)
export const tasksRuns = pgTable(
  "tasks_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .references(() => users.id),
    status: text("status").notNull().default("running"), // running, completed, failed
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_tasks_runs_task").on(table.taskId),
    index("idx_tasks_runs_org").on(table.orgId),
    index("idx_tasks_runs_status").on(table.status),
  ]
);

// Cost line items per task run
export const tasksRunsCosts = pgTable(
  "tasks_runs_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => tasksRuns.id, { onDelete: "cascade" }),
    costName: text("cost_name").notNull(),
    units: integer("units").notNull(),
    costPerUnitInUsdCents: numeric("cost_per_unit_in_usd_cents", { precision: 12, scale: 10 }).notNull(),
    totalCostInUsdCents: numeric("total_cost_in_usd_cents", { precision: 12, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_tasks_runs_costs_run").on(table.taskRunId),
    index("idx_tasks_runs_costs_name").on(table.costName),
  ]
);

// Type exports
export type ScrapeRequest = typeof scrapeRequests.$inferSelect;
export type NewScrapeRequest = typeof scrapeRequests.$inferInsert;
export type ScrapeResult = typeof scrapeResults.$inferSelect;
export type NewScrapeResult = typeof scrapeResults.$inferInsert;
export type ScrapeCache = typeof scrapeCache.$inferSelect;
export type NewScrapeCache = typeof scrapeCache.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskRun = typeof tasksRuns.$inferSelect;
export type NewTaskRun = typeof tasksRuns.$inferInsert;
export type TaskRunCost = typeof tasksRunsCosts.$inferSelect;
export type NewTaskRunCost = typeof tasksRunsCosts.$inferInsert;
