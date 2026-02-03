import { beforeAll, afterAll } from "vitest";

// Integration tests use real database - SCRAPING_SERVICE_DATABASE_URL must be set via env
if (!process.env.SCRAPING_SERVICE_DATABASE_URL) {
  throw new Error(
    "SCRAPING_SERVICE_DATABASE_URL must be set for integration tests. " +
      "These tests run against a real Neon database branch."
  );
}

// Set test API key if not provided
process.env.SCRAPING_SERVICE_API_KEY ??= "test-api-key";

beforeAll(() => {
  console.log("Integration test suite starting...");
});

afterAll(() => {
  console.log("Integration test suite complete.");
});
