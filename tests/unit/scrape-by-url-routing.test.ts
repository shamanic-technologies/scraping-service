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
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) =>
    url
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "")
  ),
}));

// Mock scrape-chain (used by scrape route instead of scrape-do directly)
vi.mock("../../src/lib/scrape-chain.js", () => ({
  scrapeWithEscalation: vi.fn().mockResolvedValue({
    response: { success: true, markdown: "# Test" },
    costName: "scrape-do-credit",
    levelName: "scrape-do-basic",
    provider: "scrape-do",
    keySource: "platform",
  }),
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

// Mock db
vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      scrapeCache: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      scrapeResults: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "req-1" }]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "res-1" }]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

import request from "supertest";
import express from "express";
import scrapeRoutes from "../../src/routes/scrape.js";

describe("GET /scrape/by-url route ordering", () => {
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

    app.use(scrapeRoutes);
  });

  it("should NOT match /scrape/by-url as /scrape/:id (regression: UUID parse error)", async () => {
    const res = await request(app)
      .get("/scrape/by-url?url=https://example.com")
      .set("x-org-id", "org_test")
      .set("x-user-id", "user_test");

    // Should get 404 (no cached result) rather than 500 (UUID parse error)
    expect(res.status).not.toBe(500);
    // The by-url handler returns 404 when no cache hit, or 400 if missing url param
    expect([400, 404]).toContain(res.status);
  });

  it("should return 400 when url query param is missing", async () => {
    const res = await request(app)
      .get("/scrape/by-url")
      .set("x-org-id", "org_test")
      .set("x-user-id", "user_test");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("url query param is required");
  });
});
