# Scraping Service - Agent Instructions

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

## Project Conventions

- TypeScript strict mode
- Functional patterns over classes
- Service-to-service auth via `X-API-Key` header (see `.cursor/skills/inter-service-communication/SKILL.md`)
- Drizzle ORM for database
- Vitest for tests
- Express router per feature (routes/ directory)
