import { describe, it, expect } from "vitest";
import {
  ScrapeRequestSchema,
  MapRequestSchema,
  KeySourceSchema,
} from "../../src/schemas.js";

describe("KeySource validation", () => {
  describe("KeySourceSchema", () => {
    it("should accept 'platform'", () => {
      expect(KeySourceSchema.parse("platform")).toBe("platform");
    });

    it("should accept 'app'", () => {
      expect(KeySourceSchema.parse("app")).toBe("app");
    });

    it("should accept 'byok'", () => {
      expect(KeySourceSchema.parse("byok")).toBe("byok");
    });

    it("should reject invalid values", () => {
      const result = KeySourceSchema.safeParse("invalid");
      expect(result.success).toBe(false);
    });
  });

  describe("ScrapeRequestSchema with keySource", () => {
    const baseRequest = {
      url: "https://example.com",
      orgId: "org-123",
    };

    it("should accept keySource: 'platform'", () => {
      const result = ScrapeRequestSchema.safeParse({
        ...baseRequest,
        keySource: "platform",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBe("platform");
      }
    });

    it("should accept keySource: 'app' with appId", () => {
      const result = ScrapeRequestSchema.safeParse({
        ...baseRequest,
        keySource: "app",
        appId: "mcpfactory",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBe("app");
        expect(result.data.appId).toBe("mcpfactory");
      }
    });

    it("should accept keySource: 'byok'", () => {
      const result = ScrapeRequestSchema.safeParse({
        ...baseRequest,
        keySource: "byok",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBe("byok");
      }
    });

    it("should reject invalid keySource", () => {
      const result = ScrapeRequestSchema.safeParse({
        ...baseRequest,
        keySource: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("should allow omitting keySource (optional)", () => {
      const result = ScrapeRequestSchema.safeParse(baseRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBeUndefined();
      }
    });
  });

  describe("MapRequestSchema with keySource", () => {
    const baseRequest = {
      url: "https://example.com",
      orgId: "org-123",
    };

    it("should accept keySource: 'platform'", () => {
      const result = MapRequestSchema.safeParse({
        ...baseRequest,
        keySource: "platform",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBe("platform");
      }
    });

    it("should accept keySource: 'app' with appId", () => {
      const result = MapRequestSchema.safeParse({
        ...baseRequest,
        keySource: "app",
        appId: "mcpfactory",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBe("app");
        expect(result.data.appId).toBe("mcpfactory");
      }
    });

    it("should accept keySource: 'byok'", () => {
      const result = MapRequestSchema.safeParse({
        ...baseRequest,
        keySource: "byok",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBe("byok");
      }
    });

    it("should reject invalid keySource", () => {
      const result = MapRequestSchema.safeParse({
        ...baseRequest,
        keySource: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("should allow omitting keySource (optional)", () => {
      const result = MapRequestSchema.safeParse(baseRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keySource).toBeUndefined();
      }
    });
  });
});
