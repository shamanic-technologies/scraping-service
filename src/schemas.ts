import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

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
    options: ScrapeOptionsSchema.optional(),
    // RunsService passthrough fields
    brandIds: z.array(z.string()).optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional(),
    featureSlug: z.string().optional(),
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
  })
  .openapi("MapRequest");

export type MapRequest = z.infer<typeof MapRequestSchema>;

const MapSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    urls: z.array(z.string()),
    count: z.number(),
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
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string(),
    targetOrgId: z.string(),
    targetBrandId: z.string().uuid().optional(),
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
