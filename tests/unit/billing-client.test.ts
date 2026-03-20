import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authorizeCredits, FIRECRAWL_CREDIT_ESTIMATE_CENTS } from "../../src/lib/billing-client.js";

describe("billing-client", () => {
  beforeEach(() => {
    vi.stubEnv("BILLING_SERVICE_URL", "https://billing.test");
    vi.stubEnv("BILLING_SERVICE_API_KEY", "billing-key-123");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("should export a positive credit estimate constant", () => {
    expect(FIRECRAWL_CREDIT_ESTIMATE_CENTS).toBeGreaterThan(0);
  });

  it("should call billing-service /v1/credits/authorize with correct payload", async () => {
    const mockResponse = { sufficient: true, balance_cents: 500, billing_mode: "payg" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const result = await authorizeCredits(1, "firecrawl-scrape-credit", {
      orgId: "org_1",
      userId: "user_1",
      runId: "run_1",
      campaignId: "camp_1",
      brandId: "brand_1",
      workflowName: "wf_1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://billing.test/v1/credits/authorize",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "billing-key-123",
          "x-org-id": "org_1",
          "x-user-id": "user_1",
          "x-run-id": "run_1",
          "x-campaign-id": "camp_1",
          "x-brand-id": "brand_1",
          "x-workflow-name": "wf_1",
        }),
        body: JSON.stringify({ required_cents: 1, description: "firecrawl-scrape-credit" }),
      })
    );

    expect(result).toEqual(mockResponse);
  });

  it("should return sufficient: false when balance is insufficient", async () => {
    const mockResponse = { sufficient: false, balance_cents: 0, billing_mode: "trial" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const result = await authorizeCredits(1, "firecrawl-scrape-credit", {
      orgId: "org_1",
      userId: "user_1",
    });

    expect(result.sufficient).toBe(false);
    expect(result.balance_cents).toBe(0);
  });

  it("should omit optional headers when identity fields are undefined", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sufficient: true, balance_cents: 100, billing_mode: "payg" }),
    } as Response);

    await authorizeCredits(1, "firecrawl-map-credit", {
      orgId: "org_1",
      userId: "user_1",
    });

    const callHeaders = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(callHeaders["x-run-id"]).toBeUndefined();
    expect(callHeaders["x-campaign-id"]).toBeUndefined();
    expect(callHeaders["x-brand-id"]).toBeUndefined();
    expect(callHeaders["x-workflow-name"]).toBeUndefined();
  });

  it("should throw when billing-service returns non-OK status", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal server error"),
    } as Response);

    await expect(
      authorizeCredits(1, "firecrawl-scrape-credit", { orgId: "org_1", userId: "user_1" })
    ).rejects.toThrow("Billing-service authorize failed: 500 - Internal server error");
  });

  it("should throw when BILLING_SERVICE_URL is not set", async () => {
    vi.stubEnv("BILLING_SERVICE_URL", "");

    await expect(
      authorizeCredits(1, "test", { orgId: "org_1", userId: "user_1" })
    ).rejects.toThrow("BILLING_SERVICE_URL is not set");
  });

  it("should throw when BILLING_SERVICE_API_KEY is not set", async () => {
    vi.stubEnv("BILLING_SERVICE_API_KEY", "");

    await expect(
      authorizeCredits(1, "test", { orgId: "org_1", userId: "user_1" })
    ).rejects.toThrow("BILLING_SERVICE_API_KEY is not set");
  });
});
