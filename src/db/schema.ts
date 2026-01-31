import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
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

// Type exports
export type ScrapeRequest = typeof scrapeRequests.$inferSelect;
export type NewScrapeRequest = typeof scrapeRequests.$inferInsert;
export type ScrapeResult = typeof scrapeResults.$inferSelect;
export type NewScrapeResult = typeof scrapeResults.$inferInsert;
export type ScrapeCache = typeof scrapeCache.$inferSelect;
export type NewScrapeCache = typeof scrapeCache.$inferInsert;
