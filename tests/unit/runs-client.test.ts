import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must set env before importing the module
vi.stubEnv("RUNS_SERVICE_URL", "https://runs.test.org");
vi.stubEnv("RUNS_SERVICE_API_KEY", "test-api-key");

const { createRun, updateRunStatus, addCosts } = await import(
  "../../src/lib/runs-client.js"
);

describe("runs-client", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createRun", () => {
    it("should POST to /v1/runs with correct body", async () => {
      const mockRun = { id: "run-123", status: "running" };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRun),
      });

      const result = await createRun({
        clerkOrgId: "org_abc",
        taskName: "scrape",
      });

      expect(result).toEqual(mockRun);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://runs.test.org/v1/runs",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-API-Key": "test-api-key",
          }),
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.clerkOrgId).toBe("org_abc");
      expect(body.appId).toBe("mcpfactory");
      expect(body.serviceName).toBe("scraping-service");
      expect(body.taskName).toBe("scrape");
    });

    it("should pass optional fields when provided", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "run-456" }),
      });

      await createRun({
        clerkOrgId: "org_abc",
        taskName: "scrape",
        brandId: "brand_1",
        campaignId: "campaign_2",
        clerkUserId: "user_3",
        parentRunId: "550e8400-e29b-41d4-a716-446655440000",
        workflowName: "gtm-outbound",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.brandId).toBe("brand_1");
      expect(body.campaignId).toBe("campaign_2");
      expect(body.clerkUserId).toBe("user_3");
      expect(body.parentRunId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(body.workflowName).toBe("gtm-outbound");
    });

    it("should not include undefined optional fields", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "run-789" }),
      });

      await createRun({
        clerkOrgId: "org_abc",
        taskName: "scrape",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("brandId");
      expect(body).not.toHaveProperty("campaignId");
      expect(body).not.toHaveProperty("clerkUserId");
      expect(body).not.toHaveProperty("parentRunId");
      expect(body).not.toHaveProperty("workflowName");
    });

    it("should throw on non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"Missing clerkOrgId"}'),
      });

      await expect(
        createRun({ clerkOrgId: "", taskName: "scrape" })
      ).rejects.toThrow("400");
    });
  });

  describe("updateRunStatus", () => {
    it("should PATCH to /v1/runs/{id}", async () => {
      const mockRun = { id: "run-123", status: "completed" };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRun),
      });

      const result = await updateRunStatus("run-123", "completed");

      expect(result).toEqual(mockRun);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://runs.test.org/v1/runs/run-123",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "completed" }),
        })
      );
    });
  });

  describe("addCosts", () => {
    it("should POST costs to /v1/runs/{id}/costs", async () => {
      const mockCosts = {
        costs: [{ id: "cost-1", costName: "firecrawl-scrape-credit" }],
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCosts),
      });

      const result = await addCosts("run-123", [
        { costName: "firecrawl-scrape-credit", quantity: 1 },
      ]);

      expect(result).toEqual(mockCosts);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://runs.test.org/v1/runs/run-123/costs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            items: [{ costName: "firecrawl-scrape-credit", quantity: 1 }],
          }),
        })
      );
    });
  });
});
