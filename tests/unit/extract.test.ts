import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing app
vi.mock("../../src/lib/key-client.js", () => ({
  resolveKey: vi
    .fn()
    .mockResolvedValue({
      provider: "firecrawl",
      key: "test-key",
      keySource: "org",
    }),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(
      message: string,
      public statusCode: number
    ) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

// Mock firecrawl
vi.mock("../../src/lib/firecrawl.js", () => ({
  extractUrl: vi.fn(),
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) =>
    url
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "")
  ),
}));

// Mock runs-client
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-123" }),
  updateRunStatus: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

// Mock billing-client
vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({
    sufficient: true,
    balance_cents: 1000,
    required_cents: 10,
    billing_mode: "credits",
  }),
}));

import request from "supertest";
import express from "express";
import extractRoutes from "../../src/routes/extract.js";
import { extractUrl } from "../../src/lib/firecrawl.js";
import { resolveKey, KeyServiceError } from "../../src/lib/key-client.js";
import { authorizeCredits } from "../../src/lib/billing-client.js";

describe("/extract endpoint", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();

    app = express();
    app.use(express.json());

    // Skip auth — set identity from headers
    app.use((req: any, _res, next) => {
      req.orgId = req.headers["x-org-id"] || "org_test";
      req.userId = req.headers["x-user-id"] || "user_test";
      req.runId = req.headers["x-run-id"] || "caller-run-id";
      next();
    });

    app.use(extractRoutes);
  });

  describe("POST /extract", () => {
    it("should return 400 when urls is missing", async () => {
      const response = await request(app).post("/extract").send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request");
    });

    it("should return 400 when urls is empty", async () => {
      const response = await request(app)
        .post("/extract")
        .send({ urls: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request");
    });

    it("should return 400 when urls exceeds max of 10", async () => {
      const urls = Array.from(
        { length: 11 },
        (_, i) => `https://example.com/article-${i}`
      );
      const response = await request(app).post("/extract").send({ urls });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request");
    });

    it("should return 400 when urls contains invalid URL", async () => {
      const response = await request(app)
        .post("/extract")
        .send({ urls: ["not-a-url"] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid request");
    });

    it("should extract authors and publishedAt from a single URL", async () => {
      vi.mocked(extractUrl).mockResolvedValueOnce({
        success: true,
        authors: [{ firstName: "Sarah", lastName: "Perez" }],
        publishedAt: "2025-11-15T00:00:00Z",
        markdown: "# Article content",
      });

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://techcrunch.com/2025/article"] });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toEqual({
        url: "https://techcrunch.com/2025/article",
        success: true,
        authors: [{ firstName: "Sarah", lastName: "Perez" }],
        publishedAt: "2025-11-15T00:00:00Z",
        rawMarkdown: "# Article content",
      });
      expect(response.body.runId).toBe("run-123");
    });

    it("should extract from multiple URLs concurrently", async () => {
      vi.mocked(extractUrl)
        .mockResolvedValueOnce({
          success: true,
          authors: [{ firstName: "Jane", lastName: "Doe" }],
          publishedAt: "2025-10-01T00:00:00Z",
          markdown: "# Article 1",
        })
        .mockResolvedValueOnce({
          success: true,
          authors: [
            { firstName: "John", lastName: "Smith" },
            { firstName: "Alice", lastName: "Johnson" },
          ],
          publishedAt: "2025-09-20T00:00:00Z",
          markdown: "# Article 2",
        });

      const response = await request(app)
        .post("/extract")
        .send({
          urls: [
            "https://example.com/article-1",
            "https://example.com/article-2",
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(2);
      expect(response.body.results[0].authors).toEqual([
        { firstName: "Jane", lastName: "Doe" },
      ]);
      expect(response.body.results[1].authors).toEqual([
        { firstName: "John", lastName: "Smith" },
        { firstName: "Alice", lastName: "Johnson" },
      ]);
    });

    it("should return per-URL errors without failing the whole batch", async () => {
      vi.mocked(extractUrl)
        .mockResolvedValueOnce({
          success: true,
          authors: [{ firstName: "Jane", lastName: "Doe" }],
          publishedAt: "2025-10-01T00:00:00Z",
          markdown: "# Works",
        })
        .mockResolvedValueOnce({
          success: false,
          error: "Page not found",
        });

      const response = await request(app)
        .post("/extract")
        .send({
          urls: [
            "https://example.com/good",
            "https://example.com/broken",
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.results[0].success).toBe(true);
      expect(response.body.results[1].success).toBe(false);
      expect(response.body.results[1].error).toBe("Page not found");
    });

    it("should return 400 when org has no Firecrawl key", async () => {
      vi.mocked(resolveKey).mockRejectedValueOnce(
        new KeyServiceError("Not found", 404)
      );

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://example.com/article"] });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("not configured");
    });

    it("should return 502 when key-service is down", async () => {
      vi.mocked(resolveKey).mockRejectedValueOnce(
        new KeyServiceError("Service unavailable", 503)
      );

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://example.com/article"] });

      expect(response.status).toBe(502);
      expect(response.body.error).toContain("retrieve");
    });

    it("should authorize credits for platform keys", async () => {
      vi.mocked(resolveKey).mockResolvedValueOnce({
        provider: "firecrawl",
        key: "platform-key",
        keySource: "platform",
      });

      vi.mocked(extractUrl).mockResolvedValueOnce({
        success: true,
        authors: [],
        publishedAt: null,
        markdown: "",
      });

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://example.com/article"] });

      expect(response.status).toBe(200);
      expect(authorizeCredits).toHaveBeenCalledWith(
        [{ costName: "firecrawl-extract-credit", quantity: 1 }],
        "firecrawl-extract-credit",
        expect.objectContaining({ orgId: "org_test", userId: "user_test" })
      );
    });

    it("should return 402 when insufficient credits", async () => {
      vi.mocked(resolveKey).mockResolvedValueOnce({
        provider: "firecrawl",
        key: "platform-key",
        keySource: "platform",
      });

      vi.mocked(authorizeCredits).mockResolvedValueOnce({
        sufficient: false,
        balance_cents: 5,
        required_cents: 10,
        billing_mode: "credits",
      });

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://example.com/article"] });

      expect(response.status).toBe(402);
      expect(response.body.error).toBe("Insufficient credits");
      expect(response.body.balance_cents).toBe(5);
    });

    it("should skip billing check for org (BYOK) keys", async () => {
      vi.mocked(extractUrl).mockResolvedValueOnce({
        success: true,
        authors: [],
        publishedAt: null,
        markdown: "",
      });

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://example.com/article"] });

      expect(response.status).toBe(200);
      expect(authorizeCredits).not.toHaveBeenCalled();
    });

    it("should handle null publishedAt gracefully", async () => {
      vi.mocked(extractUrl).mockResolvedValueOnce({
        success: true,
        authors: [{ firstName: "Bob", lastName: "Ross" }],
        publishedAt: null,
        markdown: "# No date article",
      });

      const response = await request(app)
        .post("/extract")
        .send({ urls: ["https://example.com/no-date"] });

      expect(response.status).toBe(200);
      expect(response.body.results[0].publishedAt).toBeNull();
    });

    it("should authorize credits for batch size", async () => {
      vi.mocked(resolveKey).mockResolvedValueOnce({
        provider: "firecrawl",
        key: "platform-key",
        keySource: "platform",
      });

      vi.mocked(extractUrl).mockResolvedValue({
        success: true,
        authors: [],
        publishedAt: null,
        markdown: "",
      });

      const urls = Array.from(
        { length: 5 },
        (_, i) => `https://example.com/article-${i}`
      );

      await request(app).post("/extract").send({ urls });

      expect(authorizeCredits).toHaveBeenCalledWith(
        [{ costName: "firecrawl-extract-credit", quantity: 5 }],
        "firecrawl-extract-credit",
        expect.any(Object)
      );
    });
  });
});
