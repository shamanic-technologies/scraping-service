import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../../src/lib/firecrawl.js";

describe("Firecrawl utils", () => {
  describe("normalizeUrl", () => {
    it("should remove www prefix", () => {
      expect(normalizeUrl("https://www.example.com")).toBe("example.com");
    });

    it("should remove trailing slash", () => {
      expect(normalizeUrl("https://example.com/")).toBe("example.com");
    });

    it("should preserve path", () => {
      expect(normalizeUrl("https://example.com/about")).toBe("example.com/about");
    });

    it("should lowercase", () => {
      expect(normalizeUrl("https://Example.COM")).toBe("example.com");
    });

    it("should handle complex URLs", () => {
      expect(normalizeUrl("https://www.Example.com/About/")).toBe("example.com/about");
    });
  });
});
