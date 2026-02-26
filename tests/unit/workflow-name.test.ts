import { describe, it, expect } from "vitest";
import { ScrapeRequestSchema, MapRequestSchema } from "../../src/schemas.js";

describe("workflowName passthrough", () => {
  describe("ScrapeRequestSchema", () => {
    it("should accept workflowName as optional string", () => {
      const result = ScrapeRequestSchema.safeParse({
        url: "https://example.com",
        orgId: "org_abc",
        workflowName: "gtm-outbound",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowName).toBe("gtm-outbound");
      }
    });

    it("should accept request without workflowName", () => {
      const result = ScrapeRequestSchema.safeParse({
        url: "https://example.com",
        orgId: "org_abc",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowName).toBeUndefined();
      }
    });
  });

  describe("MapRequestSchema", () => {
    it("should accept workflowName as optional string", () => {
      const result = MapRequestSchema.safeParse({
        url: "https://example.com",
        orgId: "org_abc",
        workflowName: "gtm-outbound",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowName).toBe("gtm-outbound");
      }
    });

    it("should accept request without workflowName", () => {
      const result = MapRequestSchema.safeParse({
        url: "https://example.com",
        orgId: "org_abc",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowName).toBeUndefined();
      }
    });
  });
});
