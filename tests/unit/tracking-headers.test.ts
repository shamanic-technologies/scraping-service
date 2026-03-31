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

describe("Tracking headers (x-campaign-id, x-brand-id, x-workflow-slug)", () => {
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
          brandIds: req.brandIds,
          workflowSlug: req.workflowSlug,
          featureSlug: req.featureSlug,
        });
      });
    });

    it("should extract tracking headers when present (single brand)", async () => {
      const response = await request(app)
        .post("/echo")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_1")
        .set("X-User-Id", "user_1")
        .set("X-Run-Id", "run_1")
        .set("X-Campaign-Id", "camp_123")
        .set("X-Brand-Id", "brand_456")
        .set("X-Workflow-Slug", "gtm-outbound")
        .set("X-Feature-Slug", "feature_789")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.campaignId).toBe("camp_123");
      expect(response.body.brandIds).toEqual(["brand_456"]);
      expect(response.body.workflowSlug).toBe("gtm-outbound");
      expect(response.body.featureSlug).toBe("feature_789");
    });

    it("should parse CSV x-brand-id header into brandIds array", async () => {
      const response = await request(app)
        .post("/echo")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_1")
        .set("X-User-Id", "user_1")
        .set("X-Run-Id", "run_1")
        .set("X-Brand-Id", "brand_1,brand_2,brand_3")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.brandIds).toEqual(["brand_1", "brand_2", "brand_3"]);
    });

    it("should trim whitespace in CSV brand IDs", async () => {
      const response = await request(app)
        .post("/echo")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_1")
        .set("X-User-Id", "user_1")
        .set("X-Run-Id", "run_1")
        .set("X-Brand-Id", " brand_1 , brand_2 ")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.brandIds).toEqual(["brand_1", "brand_2"]);
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
      expect(response.body.brandIds).toBeUndefined();
      expect(response.body.workflowSlug).toBeUndefined();
      expect(response.body.featureSlug).toBeUndefined();
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
        const rawBrandId = req.headers["x-brand-id"] as string | undefined;
        req.brandIds = rawBrandId
          ? String(rawBrandId).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        req.workflowSlug = req.headers["x-workflow-slug"] || undefined;
        req.featureSlug = req.headers["x-feature-slug"] || undefined;
        next();
      });
      app.use(mapRoutes);
    });

    it("should forward tracking headers to createRun identity context", async () => {
      await request(app)
        .post("/map")
        .set("X-Campaign-Id", "camp_abc")
        .set("X-Brand-Id", "brand_def")
        .set("X-Workflow-Slug", "research-flow")
        .set("X-Feature-Slug", "slug_abc")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_abc",
          brandIds: ["brand_def"],
          workflowSlug: "research-flow",
          featureSlug: "slug_abc",
        }),
        expect.objectContaining({
          campaignId: "camp_abc",
          brandIds: ["brand_def"],
          workflowSlug: "research-flow",
          featureSlug: "slug_abc",
        })
      );
    });

    it("should forward tracking headers to resolveKey", async () => {
      await request(app)
        .post("/map")
        .set("X-Campaign-Id", "camp_key")
        .set("X-Brand-Id", "brand_key")
        .set("X-Workflow-Slug", "key-flow")
        .set("X-Feature-Slug", "slug_key")
        .send({ url: "https://example.com" });

      expect(vi.mocked(resolveKey)).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_key",
          brandIds: ["brand_key"],
          workflowSlug: "key-flow",
          featureSlug: "slug_key",
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
          brandIds: undefined,
          workflowSlug: undefined,
          featureSlug: undefined,
        }),
        expect.objectContaining({
          campaignId: undefined,
          brandIds: undefined,
          workflowSlug: undefined,
          featureSlug: undefined,
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
        const rawBrandId = req.headers["x-brand-id"] as string | undefined;
        req.brandIds = rawBrandId
          ? String(rawBrandId).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        req.workflowSlug = req.headers["x-workflow-slug"] || undefined;
        req.featureSlug = req.headers["x-feature-slug"] || undefined;
        next();
      });
      app.use(mapRoutes);
    });

    it("should prefer header values over body values", async () => {
      await request(app)
        .post("/map")
        .set("X-Campaign-Id", "header-campaign")
        .set("X-Brand-Id", "header-brand")
        .set("X-Workflow-Slug", "header-workflow")
        .set("X-Feature-Slug", "header-slug")
        .send({
          url: "https://example.com",
          campaignId: "body-campaign",
          brandIds: ["body-brand"],
          workflowSlug: "body-workflow",
          featureSlug: "body-slug",
        });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "header-campaign",
          brandIds: ["header-brand"],
          workflowSlug: "header-workflow",
          featureSlug: "header-slug",
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
          brandIds: ["body-brand"],
          workflowSlug: "body-workflow",
          featureSlug: "body-slug",
        });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "body-campaign",
          brandIds: ["body-brand"],
          workflowSlug: "body-workflow",
          featureSlug: "body-slug",
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
        const rawBrandId = req.headers["x-brand-id"] as string | undefined;
        req.brandIds = rawBrandId
          ? String(rawBrandId).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        req.workflowSlug = req.headers["x-workflow-slug"] || undefined;
        req.featureSlug = req.headers["x-feature-slug"] || undefined;
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
        .set("X-Workflow-Slug", "scrape-flow")
        .set("X-Feature-Slug", "slug_scrape")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_scrape",
          brandIds: ["brand_scrape"],
          workflowSlug: "scrape-flow",
          featureSlug: "slug_scrape",
        }),
        expect.objectContaining({
          campaignId: "camp_scrape",
          brandIds: ["brand_scrape"],
          workflowSlug: "scrape-flow",
          featureSlug: "slug_scrape",
        })
      );
    });

    it("should store tracking fields in scrape_requests DB insert", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Campaign-Id", "camp_db")
        .set("X-Brand-Id", "brand_db")
        .set("X-Workflow-Slug", "db-flow")
        .set("X-Feature-Slug", "slug_db")
        .send({ url: "https://example.com" });

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_db",
          brandIds: ["brand_db"],
          workflowSlug: "db-flow",
          featureSlug: "slug_db",
        })
      );
    });

    it("should forward tracking headers to resolveKey for /scrape", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Campaign-Id", "camp_key_s")
        .set("X-Brand-Id", "brand_key_s")
        .set("X-Workflow-Slug", "key-flow-s")
        .set("X-Feature-Slug", "slug_key_s")
        .send({ url: "https://example.com" });

      expect(vi.mocked(resolveKey)).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp_key_s",
          brandIds: ["brand_key_s"],
          workflowSlug: "key-flow-s",
          featureSlug: "slug_key_s",
        })
      );
    });

    it("should forward multi-brand CSV header correctly", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Brand-Id", "brand_a,brand_b,brand_c")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          brandIds: ["brand_a", "brand_b", "brand_c"],
        }),
        expect.objectContaining({
          brandIds: ["brand_a", "brand_b", "brand_c"],
        })
      );
    });
  });
});
