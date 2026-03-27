import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB
const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      extractCache: {
        findFirst: (...args: any[]) => mockFindFirst(...args),
      },
    },
    insert: (...args: any[]) => {
      mockInsert(...args);
      return {
        values: (...vArgs: any[]) => {
          mockValues(...vArgs);
          return {
            onConflictDoUpdate: (...cArgs: any[]) => {
              mockOnConflictDoUpdate(...cArgs);
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

// Mock key-client
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
import { resolveKey } from "../../src/lib/key-client.js";
import { authorizeCredits } from "../../src/lib/billing-client.js";
import { addCosts } from "../../src/lib/runs-client.js";

describe("/extract caching", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(null); // Default: no cache

    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.orgId = req.headers["x-org-id"] || "org_test";
      req.userId = req.headers["x-user-id"] || "user_test";
      req.runId = req.headers["x-run-id"] || "caller-run-id";
      next();
    });
    app.use(extractRoutes);
  });

  it("should return cached result and skip Firecrawl call when cache hit", async () => {
    mockFindFirst.mockResolvedValueOnce({
      normalizedUrl: "techcrunch.com/2025/article",
      authors: [{ firstName: "Sarah", lastName: "Perez" }],
      publishedAt: "2025-11-15T00:00:00Z",
      isValid: true,
      expiresAt: new Date(Date.now() + 86400000), // expires tomorrow
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
      cached: true,
    });
    expect(response.body.tokensUsed).toBe(0);
    expect(response.body.cached).toBe(true);

    // Should NOT call Firecrawl, key resolution, billing, or runs
    expect(extractUrl).not.toHaveBeenCalled();
    expect(resolveKey).not.toHaveBeenCalled();
    expect(authorizeCredits).not.toHaveBeenCalled();
  });

  it("should call Firecrawl for uncached URLs and write result to cache", async () => {
    mockFindFirst.mockResolvedValueOnce(null); // cache miss

    vi.mocked(extractUrl).mockResolvedValueOnce({
      success: true,
      authors: [{ firstName: "Jane", lastName: "Doe" }],
      publishedAt: "2025-10-01T00:00:00Z",
      tokensUsed: 250,
    });

    const response = await request(app)
      .post("/extract")
      .send({ urls: ["https://example.com/article-1"] });

    expect(response.status).toBe(200);
    expect(extractUrl).toHaveBeenCalledTimes(1);

    // Should write to cache
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedUrl: "example.com/article-1",
        authors: [{ firstName: "Jane", lastName: "Doe" }],
        publishedAt: "2025-10-01T00:00:00Z",
        isValid: true,
      })
    );
  });

  it("should mix cached and fresh results in a batch", async () => {
    // First URL is cached, second is not
    mockFindFirst
      .mockResolvedValueOnce({
        normalizedUrl: "example.com/cached",
        authors: [{ firstName: "Cached", lastName: "Author" }],
        publishedAt: "2025-01-01T00:00:00Z",
        isValid: true,
        expiresAt: new Date(Date.now() + 86400000),
      })
      .mockResolvedValueOnce(null); // cache miss

    vi.mocked(extractUrl).mockResolvedValueOnce({
      success: true,
      authors: [{ firstName: "Fresh", lastName: "Author" }],
      publishedAt: "2025-06-01T00:00:00Z",
      tokensUsed: 300,
    });

    const response = await request(app)
      .post("/extract")
      .send({
        urls: [
          "https://example.com/cached",
          "https://example.com/fresh",
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(2);

    // First result from cache
    expect(response.body.results[0]).toEqual({
      url: "https://example.com/cached",
      success: true,
      authors: [{ firstName: "Cached", lastName: "Author" }],
      publishedAt: "2025-01-01T00:00:00Z",
      cached: true,
    });

    // Second result from Firecrawl
    expect(response.body.results[1]).toEqual({
      url: "https://example.com/fresh",
      success: true,
      authors: [{ firstName: "Fresh", lastName: "Author" }],
      publishedAt: "2025-06-01T00:00:00Z",
    });

    // Only 1 Firecrawl call (not 2)
    expect(extractUrl).toHaveBeenCalledTimes(1);
    // Tokens only from the fresh call
    expect(response.body.tokensUsed).toBe(300);
  });

  it("should only authorize credits for uncached URLs", async () => {
    // 1 cached, 1 uncached
    mockFindFirst
      .mockResolvedValueOnce({
        normalizedUrl: "example.com/cached",
        authors: [],
        publishedAt: null,
        isValid: true,
        expiresAt: new Date(Date.now() + 86400000),
      })
      .mockResolvedValueOnce(null);

    vi.mocked(resolveKey).mockResolvedValueOnce({
      provider: "firecrawl",
      key: "platform-key",
      keySource: "platform",
    });

    vi.mocked(extractUrl).mockResolvedValueOnce({
      success: true,
      authors: [],
      publishedAt: null,
      tokensUsed: 200,
    });

    await request(app)
      .post("/extract")
      .send({
        urls: [
          "https://example.com/cached",
          "https://example.com/fresh",
        ],
      });

    // Should authorize for 1 URL (500 tokens), not 2 (1000 tokens)
    expect(authorizeCredits).toHaveBeenCalledWith(
      [{ costName: "firecrawl-extract-token", quantity: 500 }],
      "firecrawl-extract-token",
      expect.any(Object)
    );
  });

  it("should bypass cache when skipCache is true", async () => {
    vi.mocked(extractUrl).mockResolvedValueOnce({
      success: true,
      authors: [{ firstName: "Fresh", lastName: "Author" }],
      publishedAt: "2025-06-01T00:00:00Z",
      tokensUsed: 300,
    });

    const response = await request(app)
      .post("/extract")
      .send({
        urls: ["https://example.com/article"],
        skipCache: true,
      });

    expect(response.status).toBe(200);
    // Should NOT check cache
    expect(mockFindFirst).not.toHaveBeenCalled();
    // Should call Firecrawl
    expect(extractUrl).toHaveBeenCalledTimes(1);
  });

  it("should not write failed extractions to cache", async () => {
    vi.mocked(extractUrl).mockResolvedValueOnce({
      success: false,
      error: "Page not found",
    });

    await request(app)
      .post("/extract")
      .send({ urls: ["https://example.com/broken"] });

    // Should NOT write to cache
    expect(mockValues).not.toHaveBeenCalled();
  });

  it("should not charge for fully cached requests", async () => {
    mockFindFirst.mockResolvedValueOnce({
      normalizedUrl: "example.com/cached",
      authors: [],
      publishedAt: null,
      isValid: true,
      expiresAt: new Date(Date.now() + 86400000),
    });

    await request(app)
      .post("/extract")
      .send({ urls: ["https://example.com/cached"] });

    expect(resolveKey).not.toHaveBeenCalled();
    expect(authorizeCredits).not.toHaveBeenCalled();
    expect(addCosts).not.toHaveBeenCalled();
  });
});
