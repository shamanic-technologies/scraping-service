import { describe, it, expect } from "vitest";
import {
  ScrapeRequestSchema,
  ExtractRequestSchema,
  MapRequestSchema,
  TransferBrandRequestSchema,
} from "../../src/schemas.js";

// DEPS-SEC-1025: zod 3 -> 4. Our 400 bodies return `error.flatten()`; the zod 3
// wording must survive the upgrade (src/lib/zod-v3-messages.ts).
function fieldErrors(schema: { safeParse: (v: unknown) => any }, input: unknown) {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  return r.error.flatten();
}

describe("zod 4 keeps the zod 3 validation behaviour", () => {
  it("missing field says Required", () => {
    expect(fieldErrors(ScrapeRequestSchema, {}).fieldErrors).toEqual({ url: ["Required"] });
  });

  it("bad url / wrong type / non-object keep zod 3 wording", () => {
    expect(fieldErrors(ScrapeRequestSchema, { url: "nope" }).fieldErrors.url).toEqual(["Invalid url"]);
    expect(fieldErrors(ScrapeRequestSchema, { url: 123 }).fieldErrors.url).toEqual([
      "Expected string, received number",
    ]);
    expect(fieldErrors(ScrapeRequestSchema, null).formErrors).toEqual(["Expected object, received null"]);
  });

  it("enum, int and bounds keep zod 3 wording", () => {
    expect(fieldErrors(ScrapeRequestSchema, { url: "https://a.com", provider: "x" }).fieldErrors.provider).toEqual([
      "Invalid enum value. Expected 'scrape-do' | 'firecrawl', received 'x'",
    ]);
    expect(fieldErrors(MapRequestSchema, { url: "https://a.com", limit: 1.5 }).fieldErrors.limit).toEqual([
      "Expected integer, received float",
    ]);
    expect(fieldErrors(MapRequestSchema, { url: "https://a.com", limit: 0 }).fieldErrors.limit).toEqual([
      "Number must be greater than or equal to 1",
    ]);
    expect(fieldErrors(ExtractRequestSchema, { urls: [] }).fieldErrors.urls).toEqual([
      "Array must contain at least 1 element(s)",
    ]);
    expect(
      fieldErrors(ExtractRequestSchema, { urls: ["https://a.com"], cacheTtlDays: 400 }).fieldErrors.cacheTtlDays
    ).toEqual(["Number must be less than or equal to 365"]);
  });

  it("defaults still apply", () => {
    const r = ScrapeRequestSchema.safeParse({ url: "https://a.com" });
    expect(r.success && r.data.skipCache).toBe(false);
  });

  it("brand ids accept any 8-4-4-4-12 hex id like zod 3 .uuid() did", () => {
    const base = { sourceOrgId: "o", targetOrgId: "t" };
    expect(
      TransferBrandRequestSchema.safeParse({ ...base, sourceBrandId: "00000000-0000-0000-0000-000000000001" }).success
    ).toBe(true);
    expect(fieldErrors(TransferBrandRequestSchema, { ...base, sourceBrandId: "not-a-uuid" }).fieldErrors).toEqual({
      sourceBrandId: ["Invalid uuid"],
    });
  });
});

describe("firecrawl SDK loads on zod 4 (npm override)", () => {
  it("constructs the client", async () => {
    const { default: FirecrawlApp } = await import("@mendable/firecrawl-js");
    const app = new FirecrawlApp({ apiKey: "fc-test" });
    expect(typeof app.scrapeUrl).toBe("function");
  });
});
