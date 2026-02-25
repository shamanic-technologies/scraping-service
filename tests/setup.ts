import { beforeAll, afterAll } from "vitest";

// Test environment setup
process.env.SCRAPING_SERVICE_API_KEY = "test-api-key";
process.env.KEY_SERVICE_URL = "https://key.test.org";
process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
process.env.SCRAPING_SERVICE_DATABASE_URL = "postgresql://test:test@localhost:5432/test";

beforeAll(() => {
  console.log("Test suite starting...");
});

afterAll(() => {
  console.log("Test suite complete.");
});
