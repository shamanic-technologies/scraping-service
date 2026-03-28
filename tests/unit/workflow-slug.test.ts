import { describe, it, expect } from "vitest";
import { ScrapeRequestSchema, MapRequestSchema } from "../../src/schemas.js";

describe("workflowSlug passthrough", () => {
  describe("ScrapeRequestSchema", () => {
    it("should accept workflowSlug as optional string", () => {
      const result = ScrapeRequestSchema.safeParse({
        url: "https://example.com",

        workflowSlug: "gtm-outbound",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBe("gtm-outbound");
      }
    });

    it("should accept request without workflowSlug", () => {
      const result = ScrapeRequestSchema.safeParse({
        url: "https://example.com",

      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBeUndefined();
      }
    });
  });

  describe("MapRequestSchema", () => {
    it("should accept workflowSlug as optional string", () => {
      const result = MapRequestSchema.safeParse({
        url: "https://example.com",

        workflowSlug: "gtm-outbound",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBe("gtm-outbound");
      }
    });

    it("should accept request without workflowSlug", () => {
      const result = MapRequestSchema.safeParse({
        url: "https://example.com",

      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBeUndefined();
      }
    });
  });
});
