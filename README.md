# Scraping Service

URL scraping microservice powered by [Firecrawl](https://firecrawl.dev). Extracts company information from websites with built-in caching (7-day TTL). Firecrawl API keys are auto-resolved per-request via key-service — the org's own key or the platform key is used based on the org's provider preference.

## API Endpoints

All endpoints (except `/`, `/health`, and `/openapi.json`) require these headers:

- `X-API-Key` — service-to-service authentication key
- `X-Org-Id` — internal org UUID from client-service
- `X-User-Id` — internal user UUID from client-service
- `X-Run-Id` — the caller's run ID (used as `parentRunId` when this service creates its own run in runs-service)

Optional tracking headers (injected automatically by workflow-service):

- `X-Campaign-Id` — campaign identifier (stored in DB, forwarded to downstream services)
- `X-Brand-Id` — brand identifier (stored in DB, forwarded to downstream services)
- `X-Workflow-Slug` — slug of the executing workflow (stored in DB, forwarded to downstream services)
- `X-Feature-Slug` — feature identifier (stored in DB, forwarded to downstream services)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service info (name, version) |
| `GET` | `/health` | Health check |
| `GET` | `/openapi.json` | OpenAPI 3.0 spec (generated from Zod schemas) |
| `POST` | `/scrape` | Scrape a URL and extract company info |
| `GET` | `/scrape/:id` | Get a scrape result by ID |
| `GET` | `/scrape/by-url?url=` | Get cached result by URL |
| `POST` | `/map` | Discover all URLs on a website (max 500) |
| `POST` | `/extract` | Extract article metadata (authors, date) via LLM |

### POST /scrape

```json
{
  "url": "https://example.com",
  "sourceService": "campaign",
  "sourceRefId": "ref_456",
  "skipCache": false,
  "options": {},
  "brandId": "brand_1",
  "campaignId": "campaign_2",
  "workflowSlug": "gtm-outbound",
  "featureSlug": "press-outreach"
}
```

Returns `{ cached: boolean, requestId: string, runId: string, result: {...} }`. Returns `402` with `{ error, balance_cents, required_cents }` when the org has insufficient credits (platform key only; BYOK skips billing check).

### POST /map

```json
{
  "url": "https://example.com",
  "search": "about",
  "limit": 100,
  "ignoreSitemap": false,
  "sitemapOnly": false,
  "includeSubdomains": false,
  "brandId": "brand_1",
  "campaignId": "campaign_2",
  "workflowSlug": "gtm-outbound",
  "featureSlug": "press-outreach"
}
```

Returns `{ success: boolean, urls: string[], count: number, runId: string }`. Returns `402` when insufficient credits (platform key only). Identity (`orgId`, `userId`) is provided via required `X-Org-Id` and `X-User-Id` headers.

### POST /extract

Extracts article metadata (authors, publication date) from up to 10 URLs using Firecrawl's LLM Extract. Results are cached for 6 months (180 days) by default per normalized URL. Cached URLs skip Firecrawl entirely (zero tokens, zero cost). Processes uncached URLs concurrently.

```json
{
  "urls": [
    "https://techcrunch.com/2025/11/15/some-article",
    "https://wired.com/story/another-article"
  ],
  "skipCache": false,
  "cacheTtlDays": 180,
  "brandId": "brand_1",
  "campaignId": "campaign_2",
  "workflowSlug": "journalist-outreach",
  "featureSlug": "press-outreach"
}
```

Response:

```json
{
  "results": [
    {
      "url": "https://techcrunch.com/2025/11/15/some-article",
      "success": true,
      "authors": [
        { "firstName": "Sarah", "lastName": "Perez" }
      ],
      "publishedAt": "2025-11-15T00:00:00Z"
    },
    {
      "url": "https://wired.com/story/another-article",
      "success": false,
      "error": "Page not found"
    }
  ],
  "tokensUsed": 307,
  "runId": "run-uuid"
}
```

Returns `402` when insufficient credits (platform key only; BYOK skips billing). Cost tracked as `firecrawl-extract-token` using actual token consumption reported by Firecrawl.

## Setup

```bash
cp .env.example .env   # fill in values
npm install
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SCRAPING_SERVICE_DATABASE_URL` | PostgreSQL connection string |
| `SCRAPING_SERVICE_API_KEY` | API key for service-to-service auth |
| `KEY_SERVICE_URL` | Key-service base URL for BYOK key resolution |
| `KEY_SERVICE_API_KEY` | API key for key-service |
| `RUNS_SERVICE_URL` | RunsService base URL (default: `https://runs.mcpfactory.org`) |
| `RUNS_SERVICE_API_KEY` | API key for RunsService |
| `BILLING_SERVICE_URL` | Billing-service base URL for credit authorization |
| `BILLING_SERVICE_API_KEY` | API key for billing-service |
| `PORT` | Server port (default: 3010) |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript and generate OpenAPI spec |
| `npm run generate:openapi` | Regenerate OpenAPI spec from Zod schemas |
| `npm start` | Run compiled output |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests (requires real DB) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:push` | Push schema to database |

## Database

Uses PostgreSQL via Drizzle ORM. Tables:

- **scrape_requests** - Tracks incoming scrape requests (status, source, `run_id` from RunsService, `campaign_id`, `brand_id`, `workflow_slug`, `feature_slug`, timestamps)
- **scrape_results** - Stores extracted company data (name, description, industry, contacts, raw markdown)
- **scrape_cache** - URL-based cache lookup with TTL
- **extract_cache** - LLM extraction cache (authors, publishedAt) with 7-day TTL

Run tracking and cost reporting are delegated to the external [RunsService](https://runs.mcpfactory.org).

Migrations run automatically on startup (skipped in test environment).

## Auth

Service-to-service authentication via `X-API-Key` header. The key is validated against `SCRAPING_SERVICE_API_KEY`. Required identity headers `X-Org-Id`, `X-User-Id`, and `X-Run-Id` identify the calling org, user, and parent run. Optional `X-Source-Service` header tracks the calling service.

## Docker

```bash
docker build -t scraping-service .
docker run -p 3010:3010 --env-file .env scraping-service
```

Multi-stage build: Node 20 Alpine, production dependencies, Drizzle migration files, and generated `openapi.json` in final image. Migrations run automatically on startup.

## CI

GitHub Actions runs on push to `main` and PRs:

- **test-unit** — installs deps, runs unit tests, builds TypeScript
- **test-integration** — creates a Neon DB branch per PR (via `neondatabase/create-branch-action`), pushes schema with `drizzle-kit push`, runs integration tests against the isolated branch. On `main`, uses the `SCRAPING_SERVICE_DATABASE_URL_DEV` secret instead.

A separate `neon-cleanup.yml` workflow deletes the Neon branch when the PR is closed.

### Required GitHub Secrets & Variables

| Name | Type | Description |
|------|------|-------------|
| `NEON_API_KEY` | Secret | Neon API key (Account Settings > API Keys) |
| `NEON_PROJECT_ID` | Variable | Neon project ID |
| `SCRAPING_SERVICE_DATABASE_URL_DEV` | Secret | Dev database URL for post-merge integration tests on `main` |
