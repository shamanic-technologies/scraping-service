# Project: scraping-service

URL scraping microservice powered by Firecrawl. Extracts company information from websites with built-in caching (7-day TTL).

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
