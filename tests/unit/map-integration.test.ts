import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing app
vi.mock("../../src/lib/key-client.js", () => ({
  resolveKey: vi.fn().mockResolvedValue({ provider: "firecrawl", key: "test-key", keySource: "org" }),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "map-run-id" }),
  updateRunStatus: vi.fn().mockResolvedValue(undefined),
  addCosts: vi.fn().mockResolvedValue(undefined),
}));

// Mock the firecrawl module before importing app
vi.mock("../../src/lib/firecrawl.js", () => ({
  mapUrl: vi.fn(),
  homepageLinks: vi.fn(),
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")),
}));

import request from "supertest";
import express from "express";
import mapRoutes from "../../src/routes/map.js";
import { mapUrl, homepageLinks } from "../../src/lib/firecrawl.js";
import { addCosts } from "../../src/lib/runs-client.js";
import { resolveKey, KeyServiceError } from "../../src/lib/key-client.js";

describe("/map endpoint", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    
    app = express();
    app.use(express.json());
    
    // Skip auth for tests — set identity + runId from headers
    app.use((req: any, res, next) => {
      req.orgId = req.headers["x-org-id"] || "org_test";
      req.userId = req.headers["x-user-id"] || "user_test";
      req.runId = req.headers["x-run-id"] || "caller-run-id";
      next();
    });
    
    app.use(mapRoutes);
  });

  describe("POST /map", () => {
    it("should return 400 when url is missing", async () => {
      const response = await request(app)
        .post("/map")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request");
    });

    it("should return discovered URLs on success", async () => {
      const mockUrls = [
        "https://example.com",
        "https://example.com/about",
        "https://example.com/pricing",
      ];

      vi.mocked(mapUrl).mockResolvedValueOnce({
        success: true,
        urls: mockUrls,
      });

      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.urls).toEqual(mockUrls);
      expect(response.body.count).toBe(3);
    });

    it("should accept limit above 500 (no hidden cap)", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({
        success: true,
        urls: ["https://example.com/a"],
      });

      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com", limit: 1000 });

      expect(response.status).toBe(200);
    });

    it("should return 500 when map fails", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({
        success: false,
        error: "Rate limited",
      });

      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Rate limited");
    });

    it("should return 400 when org has no Firecrawl key configured", async () => {
      vi.mocked(resolveKey).mockRejectedValueOnce(
        new KeyServiceError("Not found", 404)
      );

      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("not configured");
    });

    it("should pass search option to mapUrl", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({
        success: true,
        urls: ["https://example.com/pricing"],
      });

      await request(app)
        .post("/map")
        .send({ url: "https://example.com", search: "pricing" });

      expect(mapUrl).toHaveBeenCalledWith(
        "https://example.com",
        "test-key",
        expect.objectContaining({ search: "pricing" })
      );
    });
    it("answers with source=map and declares a map credit on a normal site", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({ success: true, urls: ["https://example.com/about"] });

      const response = await request(app).post("/map").send({ url: "https://example.com" });

      expect(response.status).toBe(200);
      expect(response.body.source).toBe("map");
      expect(homepageLinks).not.toHaveBeenCalled();
      expect(addCosts).toHaveBeenCalledWith(
        "map-run-id",
        [{ costName: "firecrawl-map-credit", quantity: 1, costSource: "org" }],
        expect.anything()
      );
    });

    it("falls back to homepage links when the map hits its ceiling, declaring only the scrape", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({ success: false, timedOut: true, error: "Map timed out" });
      vi.mocked(homepageLinks).mockResolvedValueOnce({
        success: true,
        urls: ["https://dubizzle.com/", "https://www.dubizzle.com/about/"],
      });

      const response = await request(app)
        .post("/map")
        .send({ url: "https://dubizzle.com", limit: 100, includeSubdomains: true });

      expect(response.status).toBe(200);
      expect(response.body.source).toBe("homepage-links");
      expect(response.body.urls).toEqual(["https://dubizzle.com/", "https://www.dubizzle.com/about/"]);
      expect(homepageLinks).toHaveBeenCalledWith("https://dubizzle.com", "test-key", { includeSubdomains: true, limit: 100 });
      expect(addCosts).toHaveBeenCalledWith(
        "map-run-id",
        [{ costName: "firecrawl-scrape-credit", quantity: 1, costSource: "org" }],
        expect.anything()
      );
    });

    it("returns 500 and declares nothing when both the map and the fallback fail", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({ success: false, timedOut: true, error: "Map timed out" });
      vi.mocked(homepageLinks).mockResolvedValueOnce({ success: false, error: "boom" });

      const response = await request(app).post("/map").send({ url: "https://example.com" });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("boom");
      expect(addCosts).not.toHaveBeenCalled();
    });

    it("does not fall back on a non-timeout failure", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({ success: false, error: "Rate limited" });

      const response = await request(app).post("/map").send({ url: "https://example.com" });

      expect(response.status).toBe(500);
      expect(homepageLinks).not.toHaveBeenCalled();
    });
  });
});
