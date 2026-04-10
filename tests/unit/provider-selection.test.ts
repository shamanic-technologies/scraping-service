import { describe, it, expect } from "vitest";
import { ScrapeRequestSchema, ScrapingProviderSchema } from "../../src/schemas.js";

describe("ScrapingProviderSchema", () => {
  it("should accept 'scrape-do'", () => {
    expect(ScrapingProviderSchema.parse("scrape-do")).toBe("scrape-do");
  });

  it("should accept 'firecrawl'", () => {
    expect(ScrapingProviderSchema.parse("firecrawl")).toBe("firecrawl");
  });

  it("should reject unknown providers", () => {
    const result = ScrapingProviderSchema.safeParse("unknown-provider");
    expect(result.success).toBe(false);
  });
});

describe("ScrapeRequestSchema provider field", () => {
  const baseRequest = {
    url: "https://example.com",
  };

  it("should allow omitting provider (defaults to undefined)", () => {
    const result = ScrapeRequestSchema.parse(baseRequest);
    expect(result.provider).toBeUndefined();
  });

  it("should accept provider: 'scrape-do'", () => {
    const result = ScrapeRequestSchema.parse({
      ...baseRequest,
      provider: "scrape-do",
    });
    expect(result.provider).toBe("scrape-do");
  });

  it("should accept provider: 'firecrawl'", () => {
    const result = ScrapeRequestSchema.parse({
      ...baseRequest,
      provider: "firecrawl",
    });
    expect(result.provider).toBe("firecrawl");
  });

  it("should reject invalid provider values", () => {
    const result = ScrapeRequestSchema.safeParse({
      ...baseRequest,
      provider: "playwright",
    });
    expect(result.success).toBe(false);
  });
});
