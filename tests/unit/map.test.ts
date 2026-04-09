import { describe, it, expect } from "vitest";
import { MapRequestSchema } from "../../src/schemas";

describe("MapRequestSchema limit field", () => {
  it("should not apply a default when limit is omitted", () => {
    const result = MapRequestSchema.parse({ url: "https://example.com" });
    expect(result.limit).toBeUndefined();
  });

  it("should accept any positive integer limit without cap", () => {
    const result = MapRequestSchema.parse({ url: "https://example.com", limit: 5000 });
    expect(result.limit).toBe(5000);
  });

  it("should reject limit of 0 or negative", () => {
    expect(() => MapRequestSchema.parse({ url: "https://example.com", limit: 0 })).toThrow();
    expect(() => MapRequestSchema.parse({ url: "https://example.com", limit: -1 })).toThrow();
  });
});
