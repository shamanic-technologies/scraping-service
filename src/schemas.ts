import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { DECLARABLE_OUTCOME_KEYS } from "./lib/outcome-declaration.js";
import { zodV3Message } from "./lib/zod-v3-messages.js";

extendZodWithOpenApi(z);
// Keep the zod 3 validation wording our 400 bodies have always returned.
z.config({ customError: zodV3Message });

export const registry = new OpenAPIRegistry();

// --- Security ---
registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
});

// --- Shared ---

export const ScrapingProviderSchema = z.enum(["scrape-do", "firecrawl"]).openapi("ScrapingProvider");
export type ScrapingProvider = z.infer<typeof ScrapingProviderSchema>;

const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

// Query-string list: comma-separated, the parameter repeated, or both.
const listParam = z.union([z.string(), z.array(z.string())]);
const sinceParam = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO 8601 date-time" });

// --- Scrape schemas ---

const ScrapeOptionsSchema = z
  .object({
    formats: z
      .array(z.enum(["markdown", "html", "rawHtml", "links", "screenshot"]))
      .optional(),
    onlyMainContent: z.boolean().optional(),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    waitFor: z.number().optional(),
    timeout: z.number().int().min(1000).max(300000).optional(),
  })
  .openapi("ScrapeOptions");

export const ScrapeRequestSchema = z
  .object({
    url: z.string().url(),
    provider: ScrapingProviderSchema.optional(),
    sourceService: z.string().optional(),
    sourceRefId: z.string().optional(),
    skipCache: z.boolean().optional().default(false),
    // The reuse window (ENGINE-GET-ASK-1123). Absent = unchanged behaviour.
    maxAgeDays: z
      .number()
      .int()
      .min(0)
      .max(7)
      .optional()
      .openapi({
        description:
          "How old a stored read of this page may be for the call to reuse it instead of reading the page again, in days (whole number, 0 to 7), counted from when that stored content was read. A stored read no older than this is returned free (`cached: true`, whichever org read it); an older one is ignored and the page is read fresh. 0 = always read fresh (same as skipCache: true). Absent = any stored read still kept, i.e. up to 7 days old. Above 7 is refused (400): we keep page content 7 days, nothing older exists. GET /orgs/page-reads lists what is stored and how old it is.",
        example: 2,
      }),
    // Company-info enrichment toggle. Omitted ⇒ enrich on (current behavior).
    // `false` returns the raw page body cheaply without the company-info step
    // and bypasses the shared company-info cache/result store.
    enrich: z
      .boolean()
      .optional()
      .openapi({
        description:
          "Run company-info enrichment. Defaults to true when omitted (current behavior). Set false to skip enrichment and fetch the raw body cheaply (raw-fetch mode).",
      }),
    // Force scrape.do JS rendering (render=true&super=true) for client-rendered pages.
    render: z
      .boolean()
      .optional()
      .openapi({
        description:
          "Force scrape.do JS rendering (render=true&super=true). Use for client-rendered pages whose content is not in the initial HTML.",
      }),
    options: ScrapeOptionsSchema.optional(),
    // Cost accounting (COST-ACCOUNTING-1023): the outcome this scrape is FOR.
    outcomeKey: z
      .enum(DECLARABLE_OUTCOME_KEYS)
      .optional()
      .openapi({
        description:
          'The outcome this scrape produces, stated by the caller. "company_researched" = reading a prospect\'s company website: on a fresh scrape the scrape run declares it to runs-service, subject = lead-service\'s company key (`{subjectService: "lead-service", subjectId: <normalized domain of url>}`), so every message using that research consumes it. Omitted = nothing declared: the scrape cost rolls into the caller\'s nearest declaring run (e.g. brand setup). A cache hit spends nothing and declares nothing. Declaration never fails or slows the scrape.',
      }),
    // RunsService passthrough fields
    brandIds: z.array(z.string()).optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional(),
    featureSlug: z.string().optional(),
    audienceId: z.string().optional(),
  })
  .openapi("ScrapeRequest");

export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;

const ScrapeResultSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    companyName: z.string().nullable(),
    description: z.string().nullable(),
    industry: z.string().nullable(),
    employeeCount: z.string().nullable(),
    foundedYear: z.number().nullable(),
    headquarters: z.string().nullable(),
    website: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    twitterUrl: z.string().nullable(),
    products: z.any().nullable(),
    services: z.any().nullable(),
    rawMarkdown: z.string().nullable(),
    resolvedUrl: z
      .string()
      .nullable()
      .openapi({
        description:
          "The URL the page was actually served from, after redirects. Differs from `url` when the site redirects " +
          "(e.g. a domain forwarded to another company's site): a caller that attributes the content to `url`'s owner " +
          "should check it. Null only when the provider did not report it.",
      }),
    rawHtml: z
      .string()
      .nullable()
      .openapi({
        description:
          'Raw page HTML. Populated only when options.formats includes "rawHtml"; otherwise null. Request-scoped (not cached).',
      }),
    createdAt: z.string().or(z.date()),
  })
  .openapi("ScrapeResult");

const ScrapeResponseSchema = z
  .object({
    cached: z.boolean(),
    provider: ScrapingProviderSchema.optional(),
    requestId: z.string().optional(),
    runId: z.string().optional(),
    result: ScrapeResultSchema,
  })
  .openapi("ScrapeResponse");

const ScrapeErrorResponseSchema = z
  .object({
    error: z.string(),
    requestId: z.string().optional(),
  })
  .openapi("ScrapeErrorResponse");

const InsufficientCreditsResponseSchema = z
  .object({
    error: z.string(),
    balance_cents: z.number().nullable(),
    required_cents: z.number(),
  })
  .openapi("InsufficientCreditsResponse");

const ScrapeByUrlResponseSchema = z
  .object({
    cached: z.literal(true),
    expired: z.boolean(),
    result: ScrapeResultSchema,
  })
  .openapi("ScrapeByUrlResponse");

// --- Extract schemas ---

const AuthorSchema = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
  })
  .openapi("Author");

export const ExtractRequestSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).max(10),
    skipCache: z.boolean().optional().default(false),
    cacheTtlDays: z.number().int().min(1).max(365).optional(),
    brandIds: z.array(z.string()).optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional(),
    featureSlug: z.string().optional(),
    audienceId: z.string().optional(),
  })
  .openapi("ExtractRequest");

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

const ExtractItemSuccessSchema = z
  .object({
    url: z.string(),
    success: z.literal(true),
    authors: z.array(AuthorSchema),
    publishedAt: z.string().nullable(),
    cached: z.boolean().optional(),
  })
  .openapi("ExtractItemSuccess");

const ExtractItemErrorSchema = z
  .object({
    url: z.string(),
    success: z.literal(false),
    error: z.string(),
  })
  .openapi("ExtractItemError");

const ExtractResponseSchema = z
  .object({
    results: z.array(z.union([ExtractItemSuccessSchema, ExtractItemErrorSchema])),
    tokensUsed: z.number(),
    runId: z.string().optional(),
    cached: z.boolean().optional(),
  })
  .openapi("ExtractResponse");

// --- Map schemas ---

export const MapRequestSchema = z
  .object({
    url: z.string().url(),
    search: z.string().optional(),
    limit: z.number().int().min(1).optional(),
    ignoreSitemap: z.boolean().optional(),
    sitemapOnly: z.boolean().optional(),
    includeSubdomains: z.boolean().optional(),
    brandIds: z.array(z.string()).optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional(),
    featureSlug: z.string().optional(),
    audienceId: z.string().optional(),
  })
  .openapi("MapRequest");

export type MapRequest = z.infer<typeof MapRequestSchema>;

const MapSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    urls: z.array(z.string()),
    count: z.number(),
    source: z
      .enum(["map", "homepage-links"])
      .describe(
        "map = Firecrawl site map. homepage-links = the map hit its ~18 s ceiling (big site not yet indexed by Firecrawl), so urls are the links found on the homepage instead."
      ),
    runId: z.string().optional(),
  })
  .openapi("MapSuccessResponse");

const MapErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
  })
  .openapi("MapErrorResponse");

// --- Transfer Brand schemas ---

export const TransferBrandRequestSchema = z
  .object({
    // z.guid() = the zod 3 .uuid() pattern (zod 4 .uuid() rejects non-RFC ids such as 00000000-...-000000000001)
    sourceBrandId: z.guid().openapi({ format: "uuid" }),
    sourceOrgId: z.string(),
    targetOrgId: z.string(),
    targetBrandId: z.guid().openapi({ format: "uuid" }).optional(),
  })
  .openapi("TransferBrandRequest");

export type TransferBrandRequest = z.infer<typeof TransferBrandRequestSchema>;

const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(
      z.object({
        tableName: z.string(),
        count: z.number(),
      })
    ),
  })
  .openapi("TransferBrandResponse");

// --- Health schemas ---

const ServiceInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
  })
  .openapi("ServiceInfo");

const HealthSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("Health");

// --- Path registrations ---

registry.registerPath({
  method: "get",
  path: "/",
  summary: "Service info",
  responses: {
    200: {
      description: "Service name and version",
      content: { "application/json": { schema: ServiceInfoSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Health status",
      content: { "application/json": { schema: HealthSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI spec",
  responses: {
    200: {
      description: "OpenAPI 3.0 specification",
      content: { "application/json": { schema: z.any() } },
    },
    404: {
      description: "Spec not generated",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/scrape",
  summary: "Scrape a URL and extract company information (provider: scrape-do | firecrawl)",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ScrapeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Scrape result (cached or fresh)",
      content: { "application/json": { schema: ScrapeResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    402: {
      description: "Insufficient credits (platform key only)",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    500: {
      description: "Scrape failed",
      content: { "application/json": { schema: ScrapeErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/scrape/{id}",
  summary: "Get a scrape result by ID",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Scrape result",
      content: {
        "application/json": {
          schema: z.object({ result: ScrapeResultSchema }),
        },
      },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "Result not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/scrape/by-url",
  summary: "Get cached result by URL",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({ url: z.string().url() }),
  },
  responses: {
    200: {
      description: "Cached scrape result",
      content: { "application/json": { schema: ScrapeByUrlResponseSchema } },
    },
    400: {
      description: "Missing url query param",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "No cached result found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/extract",
  summary: "Extract article metadata (authors, publication date) from URLs using LLM",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ExtractRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Extraction results (one per URL)",
      content: { "application/json": { schema: ExtractResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    402: {
      description: "Insufficient credits (platform key only)",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    500: {
      description: "Extract failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/map",
  summary: "Discover all URLs on a website",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: MapRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Map result",
      content: { "application/json": { schema: MapSuccessResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    402: {
      description: "Insufficient credits (platform key only)",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    500: {
      description: "Map failed",
      content: { "application/json": { schema: MapErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer brand ownership from one org to another (solo-brand rows only)",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer result with counts per table",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- Backlink Engine (BACKLINK-ENGINE-1109) ---

const BACKLINK_IDENTITY_NOTE =
  "Org route called AS the caller's run: headers x-api-key, x-org-id, x-user-id, x-run-id (the run every hold, actual cost and Unit is written on), x-brand-id (exactly ONE brand: the brand whose site is checked), x-campaign-id optional.";

export const BacklinkProviderSchema = z
  .enum(["dataforseo"])
  .openapi("BacklinkProvider", { description: "Backlink data provider (a tactic the caller may state; closed list). Absent = dataforseo." });

export const BacklinkCheckRequestSchema = z
  .object({
    outcomeKey: z.string().min(1).openapi({ description: 'The outcome the caller makes. Must be "backlink_earned"; anything else = 400 wrong_outcome.', example: "backlink_earned" }),
    idempotencyKey: z.string().min(1).max(200).openapi({ description: "Caller-stated key (e.g. the day). The same key again answers the completed check again: no second spend, no second Unit.", example: "2026-11-09" }),
    windowDays: z.number().int().min(1).max(365).openapi({ description: "How far back \"new\" reaches on the brand's FIRST check (links whose referring domain first linked within this many days). Later checks reuse that first window start, so they count what appeared since.", example: 60 }),
    provider: BacklinkProviderSchema.optional(),
  })
  .openapi("BacklinkCheckRequest");

const BacklinkSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Kept link id = the subject of its backlink_earned Unit (subjectService scraping-service)." }),
    referringDomain: z.string(),
    referringUrl: z.string(),
    targetUrl: z.string(),
    anchor: z.string().nullable(),
    dofollow: z.boolean().nullable(),
    domainRank: z.number().nullable().openapi({ description: "Referring domain authority, DataForSEO rank scale 0-1000 (null = unknown)." }),
    spamScore: z.number().nullable().openapi({ description: "Provider spam score 0-100 (null = unknown)." }),
    firstSeenAt: z.string().nullable().openapi({ description: "When the provider first saw this domain link to the brand." }),
    verifiedAt: z.string().openapi({ description: "When we fetched the referring page and found the link live." }),
    provider: z.string(),
    unitDeclared: z.boolean(),
    declaredRunId: z.string().nullable(),
  })
  .openapi("Backlink");

export const BacklinkCheckResponseSchema = z
  .object({
    checkId: z.string().uuid(),
    status: z.enum(["new_links_kept", "nothing_new"]),
    brandId: z.string(),
    brandDomain: z.string(),
    provider: BacklinkProviderSchema,
    outcomeKey: z.literal("backlink_earned"),
    firstCheck: z.boolean(),
    windowStart: z.string(),
    runId: z.string(),
    newLinks: z.array(BacklinkSchema).openapi({ description: "Links kept by THIS check (one per new referring domain, verified live)." }),
    unitsDeclared: z.number().int().openapi({ description: "backlink_earned Units declared on runId by this check (this check's links + any kept earlier whose Unit was not declared yet)." }),
    candidatesCount: z.number().int(),
    rejected: z.array(z.object({ referringDomain: z.string(), referringUrl: z.string(), verification: z.enum(["not_linking", "unreachable", "redirects_to_brand"]) })).openapi({ description: "Candidates not kept now (retried by the brand's next check)." }),
    newReferringDomainsCount: z.number().int(),
    truncated: z.boolean().openapi({ description: "The provider held more rows than one call returns (1000)." }),
    costMicroUsd: z.number().openapi({ description: "treg spend of this check in micro-USD (treg-micro-usd), actualized on runId." }),
    providerCalls: z.number().int(),
    checkedAt: z.string(),
    replayed: z.boolean().openapi({ description: "true = the stored answer of a completed check with the same idempotencyKey (nothing spent)." }),
  })
  .openapi("BacklinkCheckResponse");

export const BacklinkListResponseSchema = z
  .object({ brandId: z.string(), count: z.number().int(), links: z.array(BacklinkSchema) })
  .openapi("BacklinkListResponse");

export const LinkGapRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200).openapi({ example: "2026-11-09" }),
    competitors: z.array(z.string().min(3)).min(1).max(10).openapi({ description: "Competitor domains or URLs (1-10).", example: ["belkins.io", "martal.ca", "gojiberry.ai"] }),
    minCompetitors: z.number().int().min(1).max(10).openapi({ description: "Keep a source only when it links to at least this many of the competitors.", example: 2 }),
    minDomainRank: z.number().int().min(0).max(1000).openapi({ description: "Keep a source only when its rank (DataForSEO 0-1000) is at least this. 0 = no floor.", example: 200 }),
    maxSpamScore: z.number().int().min(0).max(100).openapi({ description: "Drop a source whose known spam score is above this.", example: 5 }),
    provider: BacklinkProviderSchema.optional(),
  })
  .openapi("LinkGapRequest");

export const LinkGapResponseSchema = z
  .object({
    reportId: z.string().uuid(),
    brandId: z.string(),
    brandDomain: z.string(),
    provider: BacklinkProviderSchema,
    competitors: z.array(z.string()),
    minCompetitors: z.number().int(),
    minDomainRank: z.number().int(),
    maxSpamScore: z.number().int(),
    sources: z.array(
      z.object({
        domain: z.string(),
        domainRank: z.number().nullable(),
        spamScore: z.number().nullable(),
        competitorCount: z.number().int(),
        competitors: z.array(z.string()),
      })
    ).openapi({ description: "Domains linking to >= minCompetitors competitors and NOT to the brand, most competitors then highest rank first." }),
    scannedCount: z.number().int(),
    truncated: z.boolean(),
    runId: z.string(),
    costMicroUsd: z.number(),
    providerCalls: z.number().int(),
    reportedAt: z.string(),
    replayed: z.boolean(),
  })
  .openapi("LinkGapResponse");

const BacklinkErrorSchema = z
  .object({
    error: z.string().openapi({
      description:
        "Named refusal: brand_required (400), wrong_outcome (400), invalid_competitors (400), Invalid request (400), insufficient_credit (402), brand_not_found (404), check_in_progress (409), brand_has_no_site (422), provider_unavailable / billing_unavailable / key_unavailable / brand_service_unavailable / spend_not_declared / outcome_declaration_failed / service_misconfigured (502).",
    }),
    message: z.string().optional(),
    details: z.any().optional(),
  })
  .openapi("BacklinkError");

const backlinkErrors = {
  400: { description: "brand_required | wrong_outcome | invalid_competitors | Invalid request", content: { "application/json": { schema: BacklinkErrorSchema } } },
  402: { description: "insufficient_credit", content: { "application/json": { schema: BacklinkErrorSchema } } },
  404: { description: "brand_not_found", content: { "application/json": { schema: BacklinkErrorSchema } } },
  409: { description: "check_in_progress", content: { "application/json": { schema: BacklinkErrorSchema } } },
  422: { description: "brand_has_no_site", content: { "application/json": { schema: BacklinkErrorSchema } } },
  502: { description: "provider_unavailable | billing_unavailable | key_unavailable | brand_service_unavailable | spend_not_declared | outcome_declaration_failed", content: { "application/json": { schema: BacklinkErrorSchema } } },
};

registry.registerPath({
  method: "post",
  path: "/orgs/backlinks/checks",
  summary: "Check the brand's backlinks: keep new live links, declare one backlink_earned Unit each on the caller's run",
  description:
    `${BACKLINK_IDENTITY_NOTE} Reads the referring domains that first linked to the brand's site since the brand's window start (provider via treg, metered on the caller's run: treg-micro-usd held, authorized, actualized), fetches each candidate referring page to verify the link is live now, keeps every verified link new for the brand (one referring domain = one earned link per org x brand, ever), and declares one backlink_earned Unit per kept link on x-run-id (subjectService scraping-service, subjectId = link id). Measured 2026-11-09: one call $0.024 + $0.000036 per row (~$0.026) when nothing is new, ~$0.05 when new domains exist.`,
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: BacklinkCheckRequestSchema } } } },
  responses: {
    200: { description: "Check answer (new links kept, or nothing new)", content: { "application/json": { schema: BacklinkCheckResponseSchema } } },
    ...backlinkErrors,
  },
});

export const BacklinkListQuerySchema = z
  .object({
    since: sinceParam.optional().openapi({
      format: "date-time",
      description: "Only links verified live at or after this moment (ISO 8601, compared to `verifiedAt`). Absent = every kept link.",
      example: "2026-11-01T00:00:00Z",
    }),
    ids: listParam.optional().openapi({
      description: "Only these links, by link id (= the Unit's subjectId). 1 to 100 ids, comma-separated or the parameter repeated. An id the brand does not hold is simply absent from the answer.",
      example: "5b1f0c1e-7a57-4a55-9d0a-0d1d2f3a4b5c",
    }),
    declared: z.enum(["true", "false"]).optional().openapi({
      description: '"true" = only links whose backlink_earned Unit is declared on a run (`unitDeclared: true`); "false" = only links kept but not declared yet (the brand\'s next check declares them). Absent = both.',
    }),
  })
  .openapi("BacklinkListQuery");

registry.registerPath({
  method: "get",
  path: "/orgs/backlinks",
  operationId: "listBacklinkEarnedUnits",
  tags: ["provider:backlink_earned"],
  summary: "Provider read of backlink_earned: the brand's kept links (x-brand-id), one Unit each",
  description:
    `${BACKLINK_IDENTITY_NOTE} No spend, no run opened, nothing made: it lists what we already hold. One Unit per kept link (a link from another domain to the brand's site that we fetched and found live; one referring domain = one link per org x brand, ever). Unit subject = {subjectService: "scraping-service", subjectId: <link id>}. When it was made: \`verifiedAt\`. What made it: \`declaredRunId\`, the run its Unit was declared on (null with \`unitDeclared: false\` = kept but not declared yet; the brand's next check declares it). The brand is the x-brand-id header (exactly one), the org is x-org-id: a link of another org or brand is never returned. No kept link = 200 with \`links: []\` and \`count: 0\`, never 404. Without query filters the answer is every kept link of the brand, oldest first.`,
  security: [{ apiKey: [] }],
  request: { query: BacklinkListQuerySchema },
  responses: {
    200: { description: "Kept links, oldest first (empty list when the brand holds none)", content: { "application/json": { schema: BacklinkListResponseSchema } } },
    400: backlinkErrors[400],
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/backlinks/link-gaps",
  summary: "Link gap: domains linking to several competitors but not to the brand (no Unit)",
  description: `${BACKLINK_IDENTITY_NOTE} One treg call (DataForSEO domain intersection, ~$0.024 + $0.000036 per row) metered on the caller's run like the check. Declares NO Unit. Idempotent per (idempotencyKey, sorted competitor set).`,
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: LinkGapRequestSchema } } } },
  responses: {
    200: { description: "Link-gap sources", content: { "application/json": { schema: LinkGapResponseSchema } } },
    ...backlinkErrors,
  },
});

// --- Provider reads (ENGINE-GET-ASK-1123) ---
// A Script finds these by tag `provider:<outcomeKey>`; operationIds and tags are a contract, never rename them.

const PROVIDER_READ_IDENTITY_NOTE =
  "Called AS the caller's run: headers x-api-key, x-org-id, x-user-id, x-run-id. Lists only what the calling org (x-org-id) holds; another org's Units are never returned. Never spends, never opens a run, never reads a page: it lists what we already hold. Nothing held = 200 with `units: []`, never 404.";

const limitParam = z.coerce.number().int().min(1).max(200);
const beforeParam = z.string().min(1);

const ReadContentSchema = z
  .object({
    held: z.boolean().openapi({ description: "true = the page content of THIS read is still stored. false = it is gone (deleted after 7 days, or replaced by a later read of the same page, by any org) or was never stored (raw-fetch reads: enrich:false or rawHtml)." }),
    resultId: z.string().uuid().nullable().openapi({ description: "Id of the stored content (GET /scrape/{id} returns it), null when not held." }),
    expiresAt: z.string().nullable().openapi({ description: "When the stored content is deleted (7 days after it was read), null when not held." }),
  })
  .openapi("ReadContent");

const PageReadContentSchema = ReadContentSchema.extend({
  markdown: z.string().nullable().optional().openapi({ description: "The page as markdown. Only with includeContent=true and held." }),
  title: z.string().nullable().optional().openapi({ description: "The page title (or its og:title). Only with includeContent=true and held." }),
  resolvedUrl: z.string().nullable().optional().openapi({ description: "The URL the page was served from after redirects. Only with includeContent=true and held." }),
}).openapi("PageReadContent");

export const PageReadsQuerySchema = z
  .object({
    urls: listParam.optional().openapi({
      description:
        "Only reads of these pages. 1 to 50 full URLs (with scheme), comma-separated or the parameter repeated. A read matches when its URL names the same page: same host and same path, ignoring the scheme (http/https), a leading www., the port, the query string, the fragment, one trailing slash and letter case. So https://www.Acme.com/pricing/?utm=x matches a read of http://acme.com/pricing, and does not match acme.com/pricing/eu or blog.acme.com/pricing.",
      example: "https://acme.com/pricing,https://acme.com/about",
    }),
    domain: z.string().optional().openapi({
      description: "Only reads of this site: a domain such as acme.com. Matches pages on that host and on its subdomains (blog.acme.com); a leading www. is ignored on both sides. A scheme or path in the value is ignored.",
      example: "acme.com",
    }),
    since: sinceParam.optional().openapi({
      format: "date-time",
      description: "Only pages read at or after this moment (ISO 8601, compared to `readAt`).",
      example: "2026-11-17T00:00:00Z",
    }),
    limit: limitParam.optional().openapi({
      description: "Units per page, 1 to 200. Default 50. With includeContent=true: at most 20, default 20.",
      example: 50,
    }),
    before: beforeParam.optional().openapi({
      description: "Next page: pass the previous answer's `nextBefore` unchanged, with the same filters. Returns the Units older than that page.",
    }),
    includeContent: z.enum(["true", "false"]).optional().openapi({
      description: '"true" = each Unit whose content is still held also carries the page itself (`content.markdown`, `content.title`, `content.resolvedUrl`). Default "false". With "true", limit is at most 20 (a larger limit is refused, 400).',
    }),
  })
  .openapi("PageReadsQuery");

const PageReadUnitSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "The read's id (the `requestId` POST /scrape answered)." }),
    url: z.string().openapi({ description: "The URL that was asked for." }),
    domain: z.string().nullable().openapi({ description: "The site's domain: lowercased, no scheme, www., path or port. Null when the URL names none." }),
    readAt: z.string().openapi({ description: "When the page was read (ISO 8601)." }),
    ageDays: z.number().openapi({ description: "How long ago the page was read, in days, one decimal." }),
    runId: z.string().nullable().openapi({ description: "The read's own run in runs-service (child of the caller's run); its cost sits there. Null when the run could not be opened." }),
    provider: z.string().openapi({ description: "What read the page: scrape-do or firecrawl." }),
    outcomeKey: z.string().nullable().openapi({ description: 'What the caller said the read was FOR (`outcomeKey` on POST /scrape), e.g. "company_researched". Null = the caller stated nothing (e.g. reading a client\'s own site).' }),
    brandIds: z.array(z.string()).openapi({ description: "Brands the read was made for (empty when none was stated)." }),
    campaignId: z.string().nullable(),
    content: PageReadContentSchema,
  })
  .openapi("PageReadUnit");

const pageInfo = {
  nextBefore: z.string().nullable().openapi({ description: "Cursor of the next (older) page: pass it as `before`. Null on the last page." }),
  hasMore: z.boolean().openapi({ description: "true = older Units exist beyond this page." }),
};

export const PageReadListResponseSchema = z
  .object({ units: z.array(PageReadUnitSchema).openapi({ description: "Newest read first. Empty when the org holds none." }), ...pageInfo })
  .openapi("PageReadListResponse");

export const CompanyResearchQuerySchema = z
  .object({
    domains: listParam.optional().openapi({
      description: "Only these companies, by Unit subject id = the company's domain (acme.com). 1 to 100, comma-separated or the parameter repeated. Each value is normalized like the subject id (lowercased, scheme, www., path and port dropped), so https://www.Acme.com/about asks for acme.com. Exact domain: acme.com does not return blog.acme.com.",
      example: "acme.com,globex.io",
    }),
    brandId: z.string().min(1).optional().openapi({ description: "Only research made for this brand (the scrape carried it in x-brand-id or brandIds)." }),
    campaignId: z.string().min(1).optional().openapi({ description: "Only research made under this campaign." }),
    since: sinceParam.optional().openapi({
      format: "date-time",
      description: "Only companies researched at or after this moment (ISO 8601, compared to `researchedAt`).",
      example: "2026-11-17T00:00:00Z",
    }),
    limit: limitParam.optional().openapi({ description: "Units per page, 1 to 200. Default 50.", example: 50 }),
    before: beforeParam.optional().openapi({
      description: "Next page: pass the previous answer's `nextBefore` unchanged, with the same filters. Returns the Units older than that page.",
    }),
  })
  .openapi("CompanyResearchQuery");

const CompanyResearchedUnitSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "The read's id (the `requestId` POST /scrape answered)." }),
    subject: z
      .object({ subjectService: z.literal("lead-service"), subjectId: z.string().openapi({ description: "The company's domain, as lead-service keys it.", example: "acme.com" }) })
      .openapi({ description: "The Unit's subject on the ledger." }),
    url: z.string().openapi({ description: "The page of the company's site that was read." }),
    researchedAt: z.string().openapi({ description: "When the site was read (ISO 8601)." }),
    ageDays: z.number().openapi({ description: "How long ago, in days, one decimal." }),
    runId: z.string().openapi({ description: "The run that made and declared this Unit (the scrape's own run, child of the caller's run)." }),
    brandIds: z.array(z.string()),
    campaignId: z.string().nullable(),
    workflowSlug: z.string().nullable(),
    content: ReadContentSchema,
  })
  .openapi("CompanyResearchedUnit");

export const CompanyResearchListResponseSchema = z
  .object({ units: z.array(CompanyResearchedUnitSchema).openapi({ description: "Newest first. Empty when the org holds none." }), ...pageInfo })
  .openapi("CompanyResearchListResponse");

const readErrors = {
  400: { description: "Invalid query (a filter value, limit or cursor we cannot read)", content: { "application/json": { schema: ErrorResponseSchema } } },
  401: { description: "Unauthorized" },
};

registry.registerPath({
  method: "get",
  path: "/orgs/page-reads",
  operationId: "listPageReadUnits",
  tags: ["provider:page_read"],
  summary: "Provider read of page_read: the web pages this org already had read, one Unit each",
  description:
    `${PROVIDER_READ_IDENTITY_NOTE} One Unit = one web page read fresh by POST /scrape for this org (a call answered from a stored read made no new read and has no Unit of its own). What we keep of a read: (1) the record of the read, forever: the URL, when, the run, the brands, the campaign, what it was for; (2) the page itself (markdown, metadata, the URL it was served from after redirects) for 7 days, as ONE stored copy per page shared by every org (a later read of the same page, by any org, replaces it), then deleted. \`content.held\` says whether this read's copy is still there. POST /scrape reuses a stored copy up to 7 days old instead of reading the page again: free, \`cached: true\`, whichever org read it. To get a fresher page, call POST /scrape with \`maxAgeDays\` (the oldest stored copy you accept, 0 to 7; 0 = always read fresh). Records start 2026-04-14.`,
  security: [{ apiKey: [] }],
  request: { query: PageReadsQuerySchema },
  responses: {
    200: { description: "The org's page reads, newest first (empty list when none)", content: { "application/json": { schema: PageReadListResponseSchema } } },
    ...readErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/company-research",
  operationId: "listCompanyResearchedUnits",
  tags: ["provider:company_researched"],
  summary: "Provider read of company_researched: the prospect companies whose site this org already had read, one Unit each",
  description:
    `${PROVIDER_READ_IDENTITY_NOTE} One Unit = one read of a prospect company's website, made by a POST /scrape whose caller stated \`outcomeKey: "company_researched"\`. The scrape's own run declared it to runs-service with subject {subjectService: "lead-service", subjectId: <the company's domain>}; \`runId\` is that run. A POST /scrape answered from a stored read (\`cached: true\`) makes no Unit: nothing was spent, nothing was declared. The same company can have several Units (one per fresh read). \`content.held\` says whether the page read is still stored (7 days, see GET /orgs/page-reads, which returns the page itself with includeContent=true). History: sales scrapes since 2026-04-14 are included; 4 scrapes of February 2026 predate our records and are not listed.`,
  security: [{ apiKey: [] }],
  request: { query: CompanyResearchQuerySchema },
  responses: {
    200: { description: "The org's company_researched Units, newest first (empty list when none)", content: { "application/json": { schema: CompanyResearchListResponseSchema } } },
    ...readErrors,
  },
});
