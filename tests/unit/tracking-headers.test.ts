import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before imports
vi.mock("../../src/lib/key-client.js", () => ({
  resolveKey: vi.fn().mockResolvedValue({ provider: "firecrawl", key: "test-key", keySource: "org" }),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

// Mock firecrawl before imports
vi.mock("../../src/lib/firecrawl.js", () => ({
  mapUrl: vi.fn().mockResolvedValue({ success: true, urls: ["https://example.com"] }),
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) =>
    url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()
  ),
}));

// Mock runs-client to capture createRun calls
const mockCreateRun = vi.fn().mockResolvedValue({ id: "own-run-id" });
const mockUpdateRunStatus = vi.fn().mockResolvedValue({ id: "own-run-id", status: "completed" });
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: any[]) => mockCreateRun(...args),
  updateRunStatus: (...args: any[]) => mockUpdateRunStatus(...args),
  addCosts: (...args: any[]) => mockAddCosts(...args),
}));

// Mock db module
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
import { serviceAuth } from "../../src/middleware/auth.js";
import mapRoutes from "../../src/routes/map.js";
import scrapeRoutes from "../../src/routes/scrape.js";
import { scrapeUrl } from "../../src/lib/firecrawl.js";
import { resolveKey } from "../../src/lib/key-client.js";

describe("Tracking headers (x-campaign-id, x-brand-id, x-workflow-name)", () => {
  describe("auth middleware extraction", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubEnv("SCRAPING_SERVICE_API_KEY", "test-key");

      app = express();
      app.use(express.json());
      app.use(serviceAuth);
      // Echo back what the middleware extracted
      app.post("/echo", (req: any, res) => {
        res.json({
          campaignId: req.campaignId,
          brandId: req.brandId,
          workflowName: req.workflowName,
        });
      });
    });

    it("should extract tracking headers when present", async () => {
      const response = await request(app)
        .post("/echo")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_1")
        .set("X-User-Id", "user_1")
        .set("X-Run-Id", "run_1")
        .set("X-Campaign-Id", "camp_123")
        .set("X-Brand-Id", "brand_456")
        .set("X-Workflow-Name", "gtm-outbound")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.campaignId).toBe("camp_123");
      expect(response.body.brandId).toBe("brand_456");
      expect(response.body.workflowName).toBe("gtm-outbound");
    });

    it("should not break when tracking headers are absent", async () => {
      const response = await request(app)
        .post("/echo")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_1")
        .set("X-User-Id", "user_1")
        .set("X-Run-Id", "run_1")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.campaignId).toBeUndefined();
      expect(response.body.brandId).toBeUndefined();
      expect(response.body.workflowName).toBeUndefined();
    });
  });

  describe("forwarding to runs-service via /map", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();

      app = express();
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
      app.use(mapRoutes);
    });

    it("should forward tracking headers to createRun identity context", async () => {
      await request(app)
        .post("/map")
        .set("X-Campaign-Id", "camp_abc")
        .set("X-Brand-Id", "brand_def")
        .set("X-Workflow-Name", "research-flow")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_abc",
          brandId: "brand_def",
          workflowName: "research-flow",
        }),
        expect.objectContaining({
          campaignId: "camp_abc",
          brandId: "brand_def",
          workflowName: "research-flow",
        })
      );
    });

    it("should forward tracking headers to resolveKey", async () => {
      await request(app)
        .post("/map")
        .set("X-Campaign-Id", "camp_key")
        .set("X-Brand-Id", "brand_key")
        .set("X-Workflow-Name", "key-flow")
        .send({ url: "https://example.com" });

      expect(vi.mocked(resolveKey)).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_key",
          brandId: "brand_key",
          workflowName: "key-flow",
        })
      );
    });

    it("should work without tracking headers (all undefined)", async () => {
      await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: undefined,
          brandId: undefined,
          workflowName: undefined,
        }),
        expect.objectContaining({
          campaignId: undefined,
          brandId: undefined,
          workflowName: undefined,
        })
      );
    });
  });

  describe("header precedence over body fields", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();

      app = express();
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
      app.use(mapRoutes);
    });

    it("should prefer header values over body values", async () => {
      await request(app)
        .post("/map")
        .set("X-Campaign-Id", "header-campaign")
        .set("X-Brand-Id", "header-brand")
        .set("X-Workflow-Name", "header-workflow")
        .send({
          url: "https://example.com",
          campaignId: "body-campaign",
          brandId: "body-brand",
          workflowName: "body-workflow",
        });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "header-campaign",
          brandId: "header-brand",
          workflowName: "header-workflow",
        }),
        expect.any(Object)
      );
    });

    it("should fall back to body values when headers are absent", async () => {
      await request(app)
        .post("/map")
        .send({
          url: "https://example.com",
          campaignId: "body-campaign",
          brandId: "body-brand",
          workflowName: "body-workflow",
        });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "body-campaign",
          brandId: "body-brand",
          workflowName: "body-workflow",
        }),
        expect.any(Object)
      );
    });
  });

  describe("forwarding to runs-service via /scrape", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();

      app = express();
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
      app.use(scrapeRoutes);

      vi.mocked(scrapeUrl).mockResolvedValue({
        success: true,
        markdown: "# Test",
        metadata: { title: "Test" },
      } as any);

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

    it("should forward tracking headers to createRun for /scrape", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Campaign-Id", "camp_scrape")
        .set("X-Brand-Id", "brand_scrape")
        .set("X-Workflow-Name", "scrape-flow")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_scrape",
          brandId: "brand_scrape",
          workflowName: "scrape-flow",
        }),
        expect.objectContaining({
          campaignId: "camp_scrape",
          brandId: "brand_scrape",
          workflowName: "scrape-flow",
        })
      );
    });

    it("should store tracking fields in scrape_requests DB insert", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Campaign-Id", "camp_db")
        .set("X-Brand-Id", "brand_db")
        .set("X-Workflow-Name", "db-flow")
        .send({ url: "https://example.com" });

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_db",
          brandId: "brand_db",
          workflowName: "db-flow",
        })
      );
    });

    it("should forward tracking headers to resolveKey for /scrape", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Campaign-Id", "camp_key_s")
        .set("X-Brand-Id", "brand_key_s")
        .set("X-Workflow-Name", "key-flow-s")
        .send({ url: "https://example.com" });

      expect(vi.mocked(resolveKey)).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_key_s",
          brandId: "brand_key_s",
          workflowName: "key-flow-s",
        })
      );
    });
  });
});
