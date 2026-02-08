# Scraping Service

URL scraping microservice powered by [Firecrawl](https://firecrawl.dev). Extracts company information from websites with built-in caching (7-day TTL).

## API Endpoints

All endpoints (except `/`, `/health`, and `/openapi.json`) require an `X-API-Key` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service info (name, version) |
| `GET` | `/health` | Health check |
| `GET` | `/openapi.json` | OpenAPI 3.0 spec (generated from Zod schemas) |
| `POST` | `/scrape` | Scrape a URL and extract company info |
| `GET` | `/scrape/:id` | Get a scrape result by ID |
| `GET` | `/scrape/by-url?url=` | Get cached result by URL |
| `POST` | `/map` | Discover all URLs on a website (max 500) |

### POST /scrape

```json
{
  "url": "https://example.com",
  "sourceOrgId": "org_123",
  "sourceService": "campaign",
  "sourceRefId": "ref_456",
  "skipCache": false,
  "options": {}
}
```

Returns `{ cached: boolean, requestId: string, result: {...} }`.

### POST /map

```json
{
  "url": "https://example.com",
  "search": "about",
  "limit": 100,
  "ignoreSitemap": false,
  "sitemapOnly": false,
  "includeSubdomains": false
}
```

Returns `{ success: boolean, urls: string[], count: number }`.

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
| `FIRECRAWL_API_KEY` | Firecrawl API key |
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

- **scrape_requests** - Tracks incoming scrape requests (status, source, timestamps)
- **scrape_results** - Stores extracted company data (name, description, industry, contacts, raw markdown)
- **scrape_cache** - URL-based cache lookup with TTL
- **users** - Maps Clerk user IDs to local DB
- **orgs** - Maps Clerk org IDs to local DB
- **tasks** - Task type registry
- **tasks_runs** - Task execution records with status tracking
- **tasks_runs_costs** - Per-run cost tracking (units, cost per unit)

Migrations run automatically on startup (skipped in test environment).

## Auth

Service-to-service authentication via `X-API-Key` header. The key is validated against `SCRAPING_SERVICE_API_KEY`. Optional `X-Source-Service` header tracks the calling service.

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
