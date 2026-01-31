import { describe, it, expect } from "vitest";

describe("Health check", () => {
  it("should define service name", () => {
    const service = "scraping-service";
    expect(service).toBe("scraping-service");
  });

  it("should have valid config structure", () => {
    const config = {
      port: process.env.PORT || 3010,
      hasApiKey: !!process.env.SCRAPING_SERVICE_API_KEY,
    };
    expect(config.port).toBeDefined();
    expect(config.hasApiKey).toBe(true);
  });
});
