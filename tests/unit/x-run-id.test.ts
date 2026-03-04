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

describe("X-Run-Id header", () => {
  describe("auth middleware enforcement", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubEnv("SCRAPING_SERVICE_API_KEY", "test-key");

      app = express();
      app.use(express.json());
      app.use(serviceAuth);
      app.use(mapRoutes);
    });

    it("should return 400 when X-Run-Id header is missing", async () => {
      const response = await request(app)
        .post("/map")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_test")
        .set("X-User-Id", "user_test")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing X-Run-Id header");
    });

    it("should pass when X-Run-Id header is provided", async () => {
      const response = await request(app)
        .post("/map")
        .set("X-API-Key", "test-key")
        .set("X-Org-Id", "org_test")
        .set("X-User-Id", "user_test")
        .set("X-Run-Id", "caller-run-123")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(200);
    });

    it("should not require X-Run-Id on /health", async () => {
      // Add health routes to test skipping
      const healthApp = express();
      healthApp.use(serviceAuth);
      healthApp.get("/health", (_req, res) => res.json({ status: "ok" }));

      const response = await request(healthApp).get("/health");
      expect(response.status).toBe(200);
    });

    it("should not require X-Run-Id on /", async () => {
      const healthApp = express();
      healthApp.use(serviceAuth);
      healthApp.get("/", (_req, res) => res.json({ name: "test" }));

      const response = await request(healthApp).get("/");
      expect(response.status).toBe(200);
    });
  });

  describe("parentRunId propagation to runs-service", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();

      app = express();
      app.use(express.json());
      // Skip auth — set identity + runId from headers
      app.use((req: any, _res: any, next: any) => {
        req.orgId = req.headers["x-org-id"] || "org_test";
        req.userId = req.headers["x-user-id"] || "user_test";
        req.runId = req.headers["x-run-id"] || undefined;
        next();
      });
      app.use(mapRoutes);
    });

    it("should pass x-run-id as parentRunId via identity context to createRun", async () => {
      const callerRunId = "550e8400-e29b-41d4-a716-446655440000";

      await request(app)
        .post("/map")
        .set("X-Run-Id", callerRunId)
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ taskName: "map" }),
        expect.objectContaining({ runId: callerRunId })
      );
    });

    it("should pass orgId and userId in identity context to createRun", async () => {
      await request(app)
        .post("/map")
        .set("X-Org-Id", "org_custom")
        .set("X-User-Id", "user_custom")
        .set("X-Run-Id", "run-abc")
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          orgId: "org_custom",
          userId: "user_custom",
          runId: "run-abc",
        })
      );
    });

    it("should forward identity to resolveKey", async () => {
      await request(app)
        .post("/map")
        .set("X-Org-Id", "org_fwd")
        .set("X-User-Id", "user_fwd")
        .set("X-Run-Id", "run-fwd")
        .send({ url: "https://example.com" });

      expect(vi.mocked(resolveKey)).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org_fwd",
          userId: "user_fwd",
          runId: "run-fwd",
        })
      );
    });

    it("should not accept parentRunId from request body", async () => {
      const bodyRunId = "body-run-id-should-be-ignored";
      const headerRunId = "header-run-id";

      await request(app)
        .post("/map")
        .set("X-Run-Id", headerRunId)
        .send({
          url: "https://example.com",
          parentRunId: bodyRunId,
        });

      // Should use header value, not body value
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ runId: headerRunId })
      );
    });
  });

  describe("parentRunId propagation in /scrape", () => {
    let app: express.Application;

    beforeEach(() => {
      vi.clearAllMocks();

      app = express();
      app.use(express.json());
      // Skip auth — set identity + runId from headers
      app.use((req: any, _res: any, next: any) => {
        req.orgId = req.headers["x-org-id"] || "org_test";
        req.userId = req.headers["x-user-id"] || "user_test";
        req.runId = req.headers["x-run-id"] || undefined;
        next();
      });
      app.use(scrapeRoutes);

      // Mock scrapeUrl to return success
      vi.mocked(scrapeUrl).mockResolvedValue({
        success: true,
        markdown: "# Test",
        metadata: { title: "Test" },
      } as any);

      // Mock DB returning
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

    it("should pass x-run-id as parentRunId via identity context for /scrape", async () => {
      const callerRunId = "scrape-caller-run-id";

      await request(app)
        .post("/scrape")
        .set("X-Run-Id", callerRunId)
        .send({ url: "https://example.com" });

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ taskName: "scrape" }),
        expect.objectContaining({ runId: callerRunId })
      );
    });

    it("should forward identity to resolveKey for /scrape", async () => {
      await request(app)
        .post("/scrape")
        .set("X-Org-Id", "org_s")
        .set("X-User-Id", "user_s")
        .set("X-Run-Id", "run_s")
        .send({ url: "https://example.com" });

      expect(vi.mocked(resolveKey)).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org_s",
          userId: "user_s",
          runId: "run_s",
        })
      );
    });
  });
});
