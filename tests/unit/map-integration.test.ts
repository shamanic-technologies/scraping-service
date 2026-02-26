import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing app
vi.mock("../../src/lib/key-client.js", () => ({
  decryptByokKey: vi.fn().mockResolvedValue({ provider: "firecrawl", key: "test-key" }),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

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
import { decryptByokKey, KeyServiceError } from "../../src/lib/key-client.js";

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
        .send({ url: "https://example.com", orgId: "org_test" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.urls).toEqual(mockUrls);
      expect(response.body.count).toBe(3);
    });

    it("should reject limit above 500", async () => {
      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com", limit: 1000 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request");
    });

    it("should return 500 when map fails", async () => {
      vi.mocked(mapUrl).mockResolvedValueOnce({
        success: false,
        error: "Rate limited",
      });

      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com", orgId: "org_test" });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Rate limited");
    });

    it("should return 400 when org has no Firecrawl key configured", async () => {
      vi.mocked(decryptByokKey).mockRejectedValueOnce(
        new KeyServiceError("Not found", 404)
      );

      const response = await request(app)
        .post("/map")
        .send({ url: "https://example.com", orgId: "org_no_key" });

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
        .send({ url: "https://example.com", orgId: "org_test", search: "pricing" });

      expect(mapUrl).toHaveBeenCalledWith(
        "https://example.com",
        "test-key",
        expect.objectContaining({ search: "pricing" })
      );
    });
  });
});
