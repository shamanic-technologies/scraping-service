import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock billing-client
const mockAuthorizeCredits = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredits: (...args: any[]) => mockAuthorizeCredits(...args),
  FIRECRAWL_CREDIT_ESTIMATE_CENTS: 1,
}));

// Mock key-client — default to platform key to trigger billing check
const mockResolveKey = vi.fn();
vi.mock("../../src/lib/key-client.js", () => ({
  resolveKey: (...args: any[]) => mockResolveKey(...args),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

// Mock firecrawl
vi.mock("../../src/lib/firecrawl.js", () => ({
  mapUrl: vi.fn().mockResolvedValue({ success: true, urls: ["https://example.com"] }),
  scrapeUrl: vi.fn().mockResolvedValue({
    success: true,
    markdown: "# Test",
    metadata: { title: "Test" },
  }),
  normalizeUrl: vi.fn((url: string) =>
    url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()
  ),
}));

// Mock runs-client
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-id" });
const mockUpdateRunStatus = vi.fn().mockResolvedValue({ id: "run-id", status: "completed" });
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: any[]) => mockCreateRun(...args),
  updateRunStatus: (...args: any[]) => mockUpdateRunStatus(...args),
  addCosts: (...args: any[]) => mockAddCosts(...args),
}));

// Mock db
const mockReturning = vi.fn();
const mockOnConflictDoUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  onConflictDoUpdate: mockOnConflictDoUpdate,
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockSet = vi.fn(() => ({ where: vi.fn() }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
    query: {
      scrapeCache: { findFirst: vi.fn().mockResolvedValue(null) },
      scrapeResults: { findFirst: vi.fn() },
    },
  },
}));

import request from "supertest";
import express from "express";
import scrapeRoutes from "../../src/routes/scrape.js";
import mapRoutes from "../../src/routes/map.js";

function createApp(routes: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.orgId = "org_test";
    req.userId = "user_test";
    req.runId = "run_test";
    req.campaignId = req.headers["x-campaign-id"] || undefined;
    req.brandId = req.headers["x-brand-id"] || undefined;
    req.workflowName = req.headers["x-workflow-name"] || undefined;
    next();
  });
  app.use(routes);
  return app;
}

describe("Billing authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: platform key
    mockResolveKey.mockResolvedValue({ provider: "firecrawl", key: "test-key", keySource: "platform" });

    // Default: sufficient credits
    mockAuthorizeCredits.mockResolvedValue({ sufficient: true, balance_cents: 500, billing_mode: "payg" });

    // Setup DB mock returns for scrape
    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: "req-1" }]);
      return Promise.resolve([{
        id: "result-1",
        url: "https://example.com",
        normalizedUrl: "example.com",
        companyName: "Test",
        description: "Test",
        industry: null,
      }]);
    });
  });

  describe("POST /scrape", () => {
    it("should call authorizeCredits when keySource is platform", async () => {
      const app = createApp(scrapeRoutes);

      const res = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(mockAuthorizeCredits).toHaveBeenCalledWith(
        1,
        "firecrawl-scrape-credit",
        expect.objectContaining({
          orgId: "org_test",
          userId: "user_test",
          runId: "run_test",
        })
      );
    });

    it("should return 402 when billing returns insufficient", async () => {
      mockAuthorizeCredits.mockResolvedValue({ sufficient: false, balance_cents: 0, billing_mode: "trial" });

      const app = createApp(scrapeRoutes);

      const res = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient credits");
      expect(res.body.balance_cents).toBe(0);
      expect(res.body.required_cents).toBe(1);
      // Should NOT proceed to create a run or scrape
      expect(mockCreateRun).not.toHaveBeenCalled();
    });

    it("should skip billing authorization when keySource is org (BYOK)", async () => {
      mockResolveKey.mockResolvedValue({ provider: "firecrawl", key: "user-key", keySource: "org" });

      const app = createApp(scrapeRoutes);

      const res = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(mockAuthorizeCredits).not.toHaveBeenCalled();
    });

    it("should return 502 when billing-service is unavailable", async () => {
      mockAuthorizeCredits.mockRejectedValue(new Error("Connection refused"));

      const app = createApp(scrapeRoutes);

      const res = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Billing authorization unavailable");
      expect(mockCreateRun).not.toHaveBeenCalled();
    });

    it("should forward tracking headers to authorizeCredits", async () => {
      const app = createApp(scrapeRoutes);

      await request(app)
        .post("/scrape")
        .set("X-Campaign-Id", "camp_1")
        .set("X-Brand-Id", "brand_1")
        .set("X-Workflow-Name", "wf_1")
        .send({ url: "https://example.com" });

      expect(mockAuthorizeCredits).toHaveBeenCalledWith(
        1,
        "firecrawl-scrape-credit",
        expect.objectContaining({
          campaignId: "camp_1",
          brandId: "brand_1",
          workflowName: "wf_1",
        })
      );
    });
  });

  describe("POST /map", () => {
    it("should call authorizeCredits when keySource is platform", async () => {
      const app = createApp(mapRoutes);

      const res = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(mockAuthorizeCredits).toHaveBeenCalledWith(
        1,
        "firecrawl-map-credit",
        expect.objectContaining({
          orgId: "org_test",
          userId: "user_test",
        })
      );
    });

    it("should return 402 when billing returns insufficient", async () => {
      mockAuthorizeCredits.mockResolvedValue({ sufficient: false, balance_cents: 0, billing_mode: "trial" });

      const app = createApp(mapRoutes);

      const res = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient credits");
      expect(mockCreateRun).not.toHaveBeenCalled();
    });

    it("should skip billing authorization when keySource is org (BYOK)", async () => {
      mockResolveKey.mockResolvedValue({ provider: "firecrawl", key: "user-key", keySource: "org" });

      const app = createApp(mapRoutes);

      const res = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(mockAuthorizeCredits).not.toHaveBeenCalled();
    });

    it("should return 502 when billing-service is unavailable", async () => {
      mockAuthorizeCredits.mockRejectedValue(new Error("Connection refused"));

      const app = createApp(mapRoutes);

      const res = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Billing authorization unavailable");
    });
  });
});
