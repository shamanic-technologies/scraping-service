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
    it("should POST to /v1/runs with identity headers and correct body", async () => {
      const mockRun = { id: "run-123", status: "running" };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRun),
      });

      const result = await createRun(
        { taskName: "scrape" },
        { orgId: "org_abc", userId: "user_123" }
      );

      expect(result).toEqual(mockRun);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://runs.test.org/v1/runs",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-API-Key": "test-api-key",
            "x-org-id": "org_abc",
            "x-user-id": "user_123",
          }),
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("orgId");
      expect(body).not.toHaveProperty("userId");
      expect(body.serviceName).toBe("scraping-service");
      expect(body.taskName).toBe("scrape");
    });

    it("should send x-run-id header as parentRunId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "run-456" }),
      });

      await createRun(
        { taskName: "scrape", brandIds: ["brand_1"], campaignId: "campaign_2", workflowSlug: "gtm-outbound" },
        { orgId: "org_abc", userId: "user_123", runId: "550e8400-e29b-41d4-a716-446655440000" }
      );

      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers["x-run-id"]).toBe("550e8400-e29b-41d4-a716-446655440000");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("parentRunId");
      expect(body.brandIds).toEqual(["brand_1"]);
      expect(body.campaignId).toBe("campaign_2");
      expect(body.workflowSlug).toBe("gtm-outbound");
    });

    it("should not include x-run-id header when runId is undefined", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "run-789" }),
      });

      await createRun(
        { taskName: "scrape" },
        { orgId: "org_abc", userId: "user_123" }
      );

      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers).not.toHaveProperty("x-run-id");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("brandIds");
      expect(body).not.toHaveProperty("campaignId");
      expect(body).not.toHaveProperty("workflowSlug");
    });

    it("should throw on non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"Missing x-org-id"}'),
      });

      await expect(
        createRun({ taskName: "scrape" }, { orgId: "", userId: "user_123" })
      ).rejects.toThrow("400");
    });
  });

  describe("updateRunStatus", () => {
    it("should PATCH to /v1/runs/{id} with identity headers", async () => {
      const mockRun = { id: "run-123", status: "completed" };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRun),
      });

      const result = await updateRunStatus(
        "run-123",
        "completed",
        { orgId: "org_abc", userId: "user_123", runId: "run-123" }
      );

      expect(result).toEqual(mockRun);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://runs.test.org/v1/runs/run-123",
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({
            "x-org-id": "org_abc",
            "x-user-id": "user_123",
            "x-run-id": "run-123",
          }),
          body: JSON.stringify({ status: "completed" }),
        })
      );
    });
  });

  describe("addCosts", () => {
    it("should POST costs with identity headers to /v1/runs/{id}/costs", async () => {
      const mockCosts = {
        costs: [{ id: "cost-1", costName: "firecrawl-scrape-credit" }],
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCosts),
      });

      const result = await addCosts(
        "run-123",
        [{ costName: "firecrawl-scrape-credit", quantity: 1, costSource: "org" as const }],
        { orgId: "org_abc", userId: "user_123", runId: "run-123" }
      );

      expect(result).toEqual(mockCosts);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://runs.test.org/v1/runs/run-123/costs",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-org-id": "org_abc",
            "x-user-id": "user_123",
            "x-run-id": "run-123",
          }),
          body: JSON.stringify({
            items: [{ costName: "firecrawl-scrape-credit", quantity: 1, costSource: "org" }],
          }),
        })
      );
    });

    it("should pass costSource 'platform' for platform keys", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ costs: [] }),
      });

      await addCosts(
        "run-456",
        [{ costName: "firecrawl-map-credit", quantity: 1, costSource: "platform" as const }],
        { orgId: "org_abc", userId: "user_123", runId: "run-456" }
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.items[0].costSource).toBe("platform");
    });
  });
});
