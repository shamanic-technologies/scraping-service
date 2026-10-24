# Project: scraping-service

URL scraping microservice with multi-provider support (Scrape.do default, Firecrawl). Extracts company information from websites with built-in caching (7-day TTL). `/map` and `/extract` remain Firecrawl-only.

## Commands

- `npm test` — run unit tests
- `npm run test:integration` — run integration tests (requires real DB)
- `npm run test:watch` — run tests in watch mode
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas
- `npm start` — run compiled output
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:push` — push schema to database

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/` — Route handlers (`scrape.ts`, `map.ts`, `health.ts`)
- `src/middleware/` — Middleware (`auth.ts`)
- `src/lib/` — Shared utilities (`firecrawl.ts`, `runs-client.ts`)
- `src/db/` — Drizzle ORM schema and database connection (`schema.ts`, `index.ts`)
- `src/index.ts` — Express app entrypoint
- `scripts/generate-openapi.ts` — OpenAPI spec generator
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

### Cost accounting (COST-ACCOUNTING-1023)

A scrape run declares an outcome only when the CALLER states it (`outcomeKey`): a URL does not say whether we read a prospect's company (`company_researched`) or a client's own site (brand setup, a support function, declares nothing and rolls into the caller's run). Subject of `company_researched` = `lead-service` + the url's normalized domain (lead-service `normalizeDomain`, keep the two byte-equal). Declaration is background + retried, never blocks the scrape. `src/lib/outcome-declaration.ts`. Past runs: `src/lib/outcome-backfill.ts` (+ `src/scripts/backfill-outcomes.ts`), keyed on `scrape_requests` (sales workflow scrapes only; brand setup and retired PR products stay "produced none").

### Ledger history (LEDGER-HISTORY-1024, measured 2026-10-24)

Every dollar of our runs since inception ($271.16, 135k runs, first spend 2026-02-08) sits on one of: declared `company_researched` $42.00 (5,884 sales scrapes, backfill above), support $229.13 (own `retired_product` marks + the CALLER's mark that our child run rides: brand-service `brand_setup`, outlets/PR `retired_product`, `product_feature`, plus 8 runs marked through `src/scripts/mark-support.ts`: 6 staff scrapes of our own sites `staff_experiment`, 2 outlets price-request maps `retired_product`), no output $0.03 (4 Feb 2026 sales scrapes: real attempts at `company_researched`, but `scrape_requests` starts 2026-04-14 so we hold no URL, no subject = nothing declared, never support). Failed scrapes carry $0. Re-measure BY RUN ID (`scrape_requests.run_id` loaded into a temp table on runs_service): a `service_name` scan of `runs` times out.

### Migrations gotcha (READ before any schema change)

The `drizzle/` folder is **empty** and the prod schema was applied via manual `db:push`, NOT migration files. `src/index.ts` calls `migrate(db, { migrationsFolder: "./drizzle" })` on boot, but with an empty folder that is a **no-op**. So the generic "every service auto-runs migrations at boot" assumption does NOT hold here — a new column will **silently never be created in prod** if you just edit `src/db/schema.ts` and ship.

When a schema change is genuinely needed, pick a mechanism explicitly:
- **Migration path:** `npm run db:generate` to emit `drizzle/<n>_*.sql` (boot `migrate()` then applies it). Make the SQL idempotent.
- **Manual push:** `npm run db:push` against the target DB (writes to prod DB → requires approval).

Prefer avoiding schema changes when the data is request-scoped: e.g. `result.rawHtml` is returned inline from the live scrape and never persisted, so it needed no column.

## README Maintenance (MANDATORY)

**Every time you make a code change, you MUST check if the README.md needs updating.**

Update the README when any of the following change:

- **Endpoints**: New routes, changed request/response shapes, removed endpoints
- **Environment variables**: New env vars, renamed or removed vars
- **Database schema**: New tables, renamed/removed columns, new indexes
- **Scripts**: New npm scripts, changed script behavior
- **Dependencies**: Major new dependencies that affect how the service works
- **Auth**: Changes to authentication or authorization logic
- **Docker**: Changes to Dockerfile or deployment
- **CI/CD**: Changes to GitHub Actions workflows

When updating the README:
- Keep it concise - match the existing style
- Update the relevant section only, don't rewrite the whole file
- If you add a new endpoint, add it to the API Endpoints table AND add a request/response example if the endpoint accepts a body

## Regression Tests (MANDATORY)

**Every time you fix a bug or implement a feature from an issue, you MUST create tests.**

- Add a test file in `tests/` that reproduces the issue scenario and verifies the fix
- Test the failing case (what was broken) and the passing case (the fix)
- Name test files descriptively: `tests/<feature-or-bug>.test.ts`
- Tests must pass in CI (`npm test`) — the CI runs on every PR via `.github/workflows/test.yml`
- If no test file exists yet for the affected module, create one
- If a test file already exists, add the regression test to it

This prevents the same bug from happening again. No PR should be opened without accompanying tests.

## Project Conventions

- TypeScript strict mode
- Functional patterns over classes
- Service-to-service auth via `X-API-Key` header (see `.cursor/skills/inter-service-communication/SKILL.md`)
- Drizzle ORM for database
- Vitest for tests
- Express router per feature (routes/ directory)
