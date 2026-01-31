import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../../src/lib/firecrawl.js";

describe("Scrape utils", () => {
  describe("normalizeUrl", () => {
    it("should remove protocol", () => {
      expect(normalizeUrl("https://example.com")).toBe("example.com");
      expect(normalizeUrl("http://example.com")).toBe("example.com");
    });

    it("should remove www prefix", () => {
      expect(normalizeUrl("https://www.example.com")).toBe("example.com");
      expect(normalizeUrl("http://www.example.com")).toBe("example.com");
    });

    it("should remove trailing slash", () => {
      expect(normalizeUrl("https://example.com/")).toBe("example.com");
      expect(normalizeUrl("https://example.com/about/")).toBe("example.com/about");
    });

    it("should preserve path", () => {
      expect(normalizeUrl("https://example.com/about")).toBe("example.com/about");
      expect(normalizeUrl("https://example.com/products/item")).toBe("example.com/products/item");
    });

    it("should lowercase everything", () => {
      expect(normalizeUrl("https://EXAMPLE.COM")).toBe("example.com");
      expect(normalizeUrl("https://Example.Com/About")).toBe("example.com/about");
    });

    it("should handle complex URLs", () => {
      expect(normalizeUrl("https://www.EXAMPLE.com/About/Team/")).toBe("example.com/about/team");
    });

    it("should handle malformed URLs gracefully", () => {
      expect(normalizeUrl("not-a-valid-url")).toBe("not-a-valid-url");
      expect(normalizeUrl("example.com")).toBe("example.com");
    });
  });
});
