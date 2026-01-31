import { beforeAll, afterAll } from "vitest";

// Test environment setup
process.env.SCRAPING_SERVICE_API_KEY = "test-api-key";
process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
process.env.SCRAPING_SERVICE_DATABASE_URL = "postgresql://test:test@localhost:5432/test";

beforeAll(() => {
  console.log("Test suite starting...");
});

afterAll(() => {
  console.log("Test suite complete.");
});
