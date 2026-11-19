import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client — keySource "org" so the billing-authorize branch is skipped
vi.mock("../../src/lib/key-client.js", () => ({
  resolveKey: vi.fn().mockResolvedValue({ provider: "scrape-do", key: "test-key", keySource: "org" }),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

vi.mock("../../src/lib/firecrawl.js", () => ({
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) =>
    url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()
  ),
}));

// Mock the escalation chain — return value set per test
const mockScrapeWithEscalation = vi.fn();
vi.mock("../../src/lib/scrape-chain.js", () => ({
  scrapeWithEscalation: (...args: any[]) => mockScrapeWithEscalation(...args),
}));

// Mock runs-client to capture cost declaration
const mockCreateRun = vi.fn().mockResolvedValue({ id: "own-run-id" });
const mockUpdateRunStatus = vi.fn().mockResolvedValue({ id: "own-run-id", status: "completed" });
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: any[]) => mockCreateRun(...args),
  updateRunStatus: (...args: any[]) => mockUpdateRunStatus(...args),
  addCosts: (...args: any[]) => mockAddCosts(...args),
}));

// Mock db with chainable insert/update/query
const mockReturning = vi.fn();
const mockOnConflictDoUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  onConflictDoUpdate: mockOnConflictDoUpdate,
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockSet = vi.fn(() => ({ where: vi.fn() }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockCacheFindFirst = vi.fn().mockResolvedValue(null);
const mockResultFindFirst = vi.fn().mockResolvedValue(null);

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
    query: {
      scrapeCache: { findFirst: (...a: any[]) => mockCacheFindFirst(...a) },
      scrapeResults: { findFirst: (...a: any[]) => mockResultFindFirst(...a) },
    },
  },
}));

import request from "supertest";
import express from "express";
import scrapeRoutes from "../../src/routes/scrape.js";
import { scrapeResults, scrapeCache } from "../../src/db/schema.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.orgId = req.headers["x-org-id"] || "org_test";
    req.userId = req.headers["x-user-id"] || "user_test";
    req.runId = req.headers["x-run-id"] || "caller-run-id";
    next();
  });
  app.use(scrapeRoutes);
  return app;
}


// PREVIEW-EMAIL-WRONG-BRAND-1119: pressbeat.io is forwarded (301) to distribute.you; the
// scrape returned distribute.you's homepage under pressbeat.io's URL and brand-service
// stored it as PressBeat's facts. The result now names the URL the page was served from.
describe("POST /scrape: resolvedUrl (final URL after redirects)", () => {
  let app: express.Application;
  let storedRow: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheFindFirst.mockResolvedValue(null);
    mockResultFindFirst.mockResolvedValue(null);
    app = makeApp();
    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: "req-1" }]);
      return Promise.resolve([storedRow]);
    });
  });

  function escalationResolving(resolvedUrl: string | undefined) {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, markdown: "# Title\n\n" + "word ".repeat(400), resolvedUrl },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });
  }

  it("stores and returns the URL the page was served from when the site redirects off-domain", async () => {
    storedRow = { id: "r1", url: "https://pressbeat.io", rawMarkdown: "x", resolvedUrl: "https://distribute.you/" };
    escalationResolving("https://distribute.you/");

    const res = await request(app).post("/scrape").send({ url: "https://pressbeat.io" });

    expect(res.status).toBe(200);
    expect(res.body.result.url).toBe("https://pressbeat.io");
    expect(res.body.result.resolvedUrl).toBe("https://distribute.you/");
    const resultsInsert = mockValues.mock.calls.find((c: any[]) => c[0]?.normalizedUrl !== undefined && "rawMarkdown" in c[0]);
    expect(resultsInsert?.[0].resolvedUrl).toBe("https://distribute.you/");
  });

  it("raw-fetch mode returns resolvedUrl too", async () => {
    escalationResolving("https://distribute.you/");
    const res = await request(app).post("/scrape").send({ url: "https://pressbeat.io", enrich: false });
    expect(res.status).toBe(200);
    expect(res.body.result.resolvedUrl).toBe("https://distribute.you/");
  });

  it("a cached row with no recorded resolvedUrl is a miss: scraped fresh so the final URL is known", async () => {
    mockCacheFindFirst.mockResolvedValue({ resultId: "old", expiresAt: new Date(Date.now() + 1e9) });
    mockResultFindFirst.mockResolvedValue({ id: "old", url: "https://pressbeat.io", rawMarkdown: "word ".repeat(400), resolvedUrl: null });
    storedRow = { id: "r1", url: "https://pressbeat.io", rawMarkdown: "x", resolvedUrl: "https://distribute.you/" };
    escalationResolving("https://distribute.you/");

    const res = await request(app).post("/scrape").send({ url: "https://pressbeat.io" });

    expect(res.body.cached).toBe(false);
    expect(mockScrapeWithEscalation).toHaveBeenCalledTimes(1);
    expect(res.body.result.resolvedUrl).toBe("https://distribute.you/");
  });

  it("a cached row with a recorded resolvedUrl is served from cache", async () => {
    mockCacheFindFirst.mockResolvedValue({ resultId: "ok", expiresAt: new Date(Date.now() + 1e9) });
    mockResultFindFirst.mockResolvedValue({ id: "ok", url: "https://example.com", rawMarkdown: "word ".repeat(400), resolvedUrl: "https://example.com/" });

    const res = await request(app).post("/scrape").send({ url: "https://example.com" });

    expect(res.body.cached).toBe(true);
    expect(res.body.result.resolvedUrl).toBe("https://example.com/");
    expect(mockScrapeWithEscalation).not.toHaveBeenCalled();
  });
});
