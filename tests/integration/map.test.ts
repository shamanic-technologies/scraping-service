import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the firecrawl module before importing app
vi.mock("../../src/lib/firecrawl.js", () => ({
  mapUrl: vi.fn(),
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")),
}));

import request from "supertest";
import express from "express";
import mapRoutes from "../../src/routes/map.js";
import { mapUrl } from "../../src/lib/firecrawl.js";

describe("/map endpoint", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    
    app = express();
    app.use(express.json());
    
    // Skip auth for tests
    app.use((req, res, next) => next());
    
    app.use(mapRoutes);
  });

  describe("POST /map", () => {
    it("should return 400 when url is missing", async () => {
      const response = await request(app)
        .post("/map")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("url is required");
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

    it("should cap limit at 500", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({
        success: true,
        urls: [],
      });

      await request(app)
        .post("/map")
        .send({ url: "https://example.com", limit: 1000 });

      expect(mapUrl).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ limit: 500 })
      );
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
        expect.objectContaining({ search: "pricing" })
      );
    });
  });
});
