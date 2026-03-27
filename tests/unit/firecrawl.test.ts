import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  splitAuthorName,
  parseAuthorsFromMetadata,
  parsePublishedAtFromMetadata,
} from "../../src/lib/firecrawl.js";

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

  describe("splitAuthorName", () => {
    it("should split first and last name", () => {
      expect(splitAuthorName("Sarah Perez")).toEqual({
        firstName: "Sarah",
        lastName: "Perez",
      });
    });

    it("should handle single name", () => {
      expect(splitAuthorName("Madonna")).toEqual({
        firstName: "Madonna",
        lastName: "",
      });
    });

    it("should handle three-part names", () => {
      expect(splitAuthorName("Mary Jane Watson")).toEqual({
        firstName: "Mary Jane",
        lastName: "Watson",
      });
    });

    it("should return null for empty string", () => {
      expect(splitAuthorName("")).toBeNull();
    });

    it("should return null for organization names", () => {
      expect(splitAuthorName("Reuters Staff")).toBeNull();
      expect(splitAuthorName("AP")).toBeNull();
      expect(splitAuthorName("Editorial Team")).toBeNull();
      expect(splitAuthorName("News Desk")).toBeNull();
      expect(splitAuthorName("Associated Press")).toBeNull();
    });

    it("should trim whitespace", () => {
      expect(splitAuthorName("  John Doe  ")).toEqual({
        firstName: "John",
        lastName: "Doe",
      });
    });
  });

  describe("parseAuthorsFromMetadata", () => {
    it("should parse author from 'author' meta tag", () => {
      const result = parseAuthorsFromMetadata({ author: "Jane Doe" });
      expect(result).toEqual([{ firstName: "Jane", lastName: "Doe" }]);
    });

    it("should parse author from 'article:author' meta tag", () => {
      const result = parseAuthorsFromMetadata({ "article:author": "John Smith" });
      expect(result).toEqual([{ firstName: "John", lastName: "Smith" }]);
    });

    it("should parse comma-separated authors", () => {
      const result = parseAuthorsFromMetadata({ author: "Jane Doe, John Smith" });
      expect(result).toEqual([
        { firstName: "Jane", lastName: "Doe" },
        { firstName: "John", lastName: "Smith" },
      ]);
    });

    it("should parse 'and'-separated authors", () => {
      const result = parseAuthorsFromMetadata({ author: "Jane Doe and John Smith" });
      expect(result).toEqual([
        { firstName: "Jane", lastName: "Doe" },
        { firstName: "John", lastName: "Smith" },
      ]);
    });

    it("should return empty array when no author metadata", () => {
      const result = parseAuthorsFromMetadata({ title: "Article Title" });
      expect(result).toEqual([]);
    });

    it("should filter out organization names", () => {
      const result = parseAuthorsFromMetadata({ author: "Reuters Staff" });
      expect(result).toEqual([]);
    });

    it("should deduplicate authors", () => {
      const result = parseAuthorsFromMetadata({
        author: "Jane Doe",
        "article:author": "Jane Doe",
      });
      // The first matching key wins, so only one entry
      expect(result).toEqual([{ firstName: "Jane", lastName: "Doe" }]);
    });

    it("should parse authors from JSON-LD", () => {
      const result = parseAuthorsFromMetadata({
        jsonLd: {
          "@type": "Article",
          author: { "@type": "Person", name: "Sarah Perez" },
        },
      });
      expect(result).toEqual([{ firstName: "Sarah", lastName: "Perez" }]);
    });

    it("should parse multiple authors from JSON-LD array", () => {
      const result = parseAuthorsFromMetadata({
        jsonLd: {
          "@type": "NewsArticle",
          author: [
            { "@type": "Person", name: "Jane Doe" },
            { "@type": "Person", name: "John Smith" },
          ],
        },
      });
      expect(result).toEqual([
        { firstName: "Jane", lastName: "Doe" },
        { firstName: "John", lastName: "Smith" },
      ]);
    });

    it("should handle JSON-LD array at top level", () => {
      const result = parseAuthorsFromMetadata({
        jsonLd: [
          {
            "@type": "BlogPosting",
            author: "Alice Johnson",
          },
        ],
      });
      expect(result).toEqual([{ firstName: "Alice", lastName: "Johnson" }]);
    });
  });

  describe("parsePublishedAtFromMetadata", () => {
    it("should parse article:published_time", () => {
      const result = parsePublishedAtFromMetadata({
        "article:published_time": "2025-11-15T10:30:00Z",
      });
      expect(result).toBe("2025-11-15T10:30:00.000Z");
    });

    it("should parse og:article:published_time", () => {
      const result = parsePublishedAtFromMetadata({
        "og:article:published_time": "2025-11-15",
      });
      expect(result).toBe("2025-11-15T00:00:00.000Z");
    });

    it("should parse datePublished", () => {
      const result = parsePublishedAtFromMetadata({
        datePublished: "2025-06-20T14:00:00+02:00",
      });
      expect(result).not.toBeNull();
    });

    it("should return null when no date metadata", () => {
      const result = parsePublishedAtFromMetadata({ title: "No Date Article" });
      expect(result).toBeNull();
    });

    it("should return null for invalid date strings", () => {
      const result = parsePublishedAtFromMetadata({
        "article:published_time": "not-a-date",
      });
      expect(result).toBeNull();
    });

    it("should parse date from JSON-LD", () => {
      const result = parsePublishedAtFromMetadata({
        jsonLd: {
          "@type": "Article",
          datePublished: "2025-03-10T08:00:00Z",
        },
      });
      expect(result).toBe("2025-03-10T08:00:00.000Z");
    });

    it("should prefer meta tag over JSON-LD", () => {
      const result = parsePublishedAtFromMetadata({
        "article:published_time": "2025-01-01T00:00:00Z",
        jsonLd: {
          "@type": "Article",
          datePublished: "2025-12-31T00:00:00Z",
        },
      });
      expect(result).toBe("2025-01-01T00:00:00.000Z");
    });
  });
});
