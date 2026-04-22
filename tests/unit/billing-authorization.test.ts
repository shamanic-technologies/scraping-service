import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock billing-client
const mockAuthorizeCredits = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredits: (...args: any[]) => mockAuthorizeCredits(...args),
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

// Mock scrape-chain (used by scrape route instead of scrape-do directly)
vi.mock("../../src/lib/scrape-chain.js", () => ({
  scrapeWithEscalation: vi.fn().mockResolvedValue({
    response: { success: true, markdown: "# Test", requestCost: 1 },
    costName: "scrape-do-credit",
    levelName: "scrape-do-basic",
    provider: "scrape-do",
    keySource: "platform",
    requestCost: 1,
  }),
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
    const rawBrandId = req.headers["x-brand-id"] as string | undefined;
        req.brandIds = rawBrandId
          ? String(rawBrandId).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
    req.workflowSlug = req.headers["x-workflow-slug"] || undefined;
    next();
  });
  app.use(routes);
  return app;
}

describe("Billing authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: platform key (provider echoes whatever was requested)
    mockResolveKey.mockImplementation((params: any) =>
      Promise.resolve({ provider: params.provider, key: "test-key", keySource: "platform" })
    );

    // Default: sufficient credits (billing-service resolves price, returns required_cents)
    mockAuthorizeCredits.mockResolvedValue({ sufficient: true, balance_cents: 500, required_cents: 3, billing_mode: "payg" });

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
    it("should call authorizeCredits with items array when keySource is platform", async () => {
      const app = createApp(scrapeRoutes);

      const res = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(mockAuthorizeCredits).toHaveBeenCalledWith(
        [{ costName: "scrape-do-credit", quantity: 25 }],
        "scrape-do-credit",
        expect.objectContaining({
          orgId: "org_test",
          userId: "user_test",
          runId: "run_test",
        })
      );
    });

    it("should return 402 with required_cents from billing-service when insufficient", async () => {
      mockAuthorizeCredits.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 3, billing_mode: "trial" });

      const app = createApp(scrapeRoutes);

      const res = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient credits");
      expect(res.body.balance_cents).toBe(0);
      expect(res.body.required_cents).toBe(3);
      expect(mockCreateRun).not.toHaveBeenCalled();
    });

    it("should skip billing authorization when keySource is org (BYOK)", async () => {
      mockResolveKey.mockImplementation((params: any) =>
        Promise.resolve({ provider: params.provider, key: "user-key", keySource: "org" })
      );

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
        .set("X-Workflow-Slug", "wf_1")
        .send({ url: "https://example.com" });

      expect(mockAuthorizeCredits).toHaveBeenCalledWith(
        [{ costName: "scrape-do-credit", quantity: 25 }],
        "scrape-do-credit",
        expect.objectContaining({
          campaignId: "camp_1",
          brandIds: ["brand_1"],
          workflowSlug: "wf_1",
        })
      );
    });
  });

  describe("POST /map", () => {
    it("should call authorizeCredits with items array when keySource is platform", async () => {
      const app = createApp(mapRoutes);

      const res = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(mockAuthorizeCredits).toHaveBeenCalledWith(
        [{ costName: "firecrawl-map-credit", quantity: 1 }],
        "firecrawl-map-credit",
        expect.objectContaining({
          orgId: "org_test",
          userId: "user_test",
        })
      );
    });

    it("should return 402 when billing returns insufficient", async () => {
      mockAuthorizeCredits.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 3, billing_mode: "trial" });

      const app = createApp(mapRoutes);

      const res = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient credits");
      expect(res.body.required_cents).toBe(3);
      expect(mockCreateRun).not.toHaveBeenCalled();
    });

    it("should skip billing authorization when keySource is org (BYOK)", async () => {
      mockResolveKey.mockImplementation((params: any) =>
        Promise.resolve({ provider: params.provider, key: "user-key", keySource: "org" })
      );

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
