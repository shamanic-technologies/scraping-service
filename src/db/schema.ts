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
    orgId: text("org_id").notNull(),
    sourceRefId: text("source_ref_id"), // Campaign ID, pitch ID, etc.

    // Request details
    url: text("url").notNull(),
    provider: text("provider").notNull(), // 'firecrawl' | 'scrape-do'
    options: jsonb("options"), // { formats: ['markdown'], ... }

    // RunsService run ID
    runId: text("run_id"),

    // Tracking headers (injected by workflow-service)
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    audienceId: text("audience_id"), // cost attribution per audience



    // Status tracking
    status: text("status").notNull().default("pending"), // 'pending', 'processing', 'completed', 'failed'
    errorMessage: text("error_message"),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_scrape_requests_source").on(table.sourceService, table.orgId),
    index("idx_scrape_requests_url").on(table.url),
    index("idx_scrape_requests_status").on(table.status),
    index("idx_scrape_requests_brand_ids").using("gin", table.brandIds),
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

/**
 * Extract cache - stores LLM extraction results (authors, publishedAt)
 * to avoid re-calling Firecrawl's expensive /v1/extract API for the same URL.
 * 7-day TTL, keyed on normalizedUrl.
 */
export const extractCache = pgTable(
  "extract_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedUrl: text("normalized_url").notNull().unique(),

    // Extracted data
    authors: jsonb("authors"), // Array of { firstName, lastName }
    publishedAt: text("published_at"),

    // Cache validity
    isValid: boolean("is_valid").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_extract_cache_normalized_url").on(table.normalizedUrl),
    index("idx_extract_cache_expires").on(table.expiresAt),
  ]
);

/**
 * Backlink checks (BACKLINK-ENGINE-1109): one row per (org, brand, caller idempotency key).
 * `windowStart` = how far back "new" reaches: set by the brand's FIRST check from the
 * caller's windowDays, reused by every later check of that org × brand.
 * `answer` = the completed answer, served again on a replay (no second spend).
 */
export const backlinkChecks = pgTable(
  "backlink_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    runId: text("run_id").notNull(),
    campaignId: text("campaign_id"),
    provider: text("provider").notNull(),
    brandDomain: text("brand_domain"),
    windowStart: timestamp("window_start", { withTimezone: true }),
    status: text("status").notNull(), // 'running' | 'completed' | 'failed'
    errorCode: text("error_code"),
    answer: jsonb("answer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_backlink_checks_idem").on(table.orgId, table.brandId, table.idempotencyKey),
    index("idx_backlink_checks_brand").on(table.orgId, table.brandId, table.createdAt),
  ]
);

/**
 * Kept backlinks: a link from another domain to the brand's site, verified live on the
 * referring page. One referring domain = one earned link per org × brand, ever. The row id
 * is the subject of its `backlink_earned` Unit (subjectService "scraping-service").
 * `declaredRunId` null = Unit not yet declared (the next check of the brand declares it).
 */
export const brandBacklinks = pgTable(
  "brand_backlinks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    referringDomain: text("referring_domain").notNull(),
    referringUrl: text("referring_url").notNull(),
    targetUrl: text("target_url").notNull(),
    anchor: text("anchor"),
    dofollow: boolean("dofollow"),
    domainRank: integer("domain_rank"),
    spamScore: integer("spam_score"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    provider: text("provider").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    checkId: uuid("check_id").notNull(),
    declaredRunId: text("declared_run_id"),
    declaredAt: timestamp("declared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_brand_backlinks_domain").on(table.orgId, table.brandId, table.referringDomain),
  ]
);

/**
 * Link-gap reports (BACKLINK-ENGINE-1109): domains linking to several of the brand's
 * competitors but not to the brand. Material for outreach, never a Unit. One row per
 * (org, brand, idempotency key, sorted competitor set); `answer` served again on a replay.
 */
export const linkGapReports = pgTable(
  "link_gap_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    competitorsKey: text("competitors_key").notNull(),
    runId: text("run_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    answer: jsonb("answer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_link_gap_reports_idem").on(table.orgId, table.brandId, table.idempotencyKey, table.competitorsKey),
  ]
);

// Type exports
export type ScrapeRequest = typeof scrapeRequests.$inferSelect;
export type NewScrapeRequest = typeof scrapeRequests.$inferInsert;
export type ScrapeResult = typeof scrapeResults.$inferSelect;
export type NewScrapeResult = typeof scrapeResults.$inferInsert;
export type ScrapeCache = typeof scrapeCache.$inferSelect;
export type NewScrapeCache = typeof scrapeCache.$inferInsert;
export type ExtractCache = typeof extractCache.$inferSelect;
export type NewExtractCache = typeof extractCache.$inferInsert;
