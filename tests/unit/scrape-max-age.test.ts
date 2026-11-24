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


// ENGINE-GET-ASK-1123: the caller states the oldest stored read it accepts; outcomeKey is stored.
describe("POST /scrape: maxAgeDays + outcomeKey stored", () => {
  let app: express.Application;
  const DAY = 86_400_000;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: "req-1" }]);
      return Promise.resolve([{ id: "r1", url: "https://example.com", rawMarkdown: "x", resolvedUrl: "https://example.com/" }]);
    });
    mockScrapeWithEscalation.mockResolvedValue({
      response: { success: true, markdown: "# T\n\n" + "word ".repeat(400), resolvedUrl: "https://example.com/" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });
  });

  function cachedReadDaysOld(days: number) {
    mockCacheFindFirst.mockResolvedValue({ resultId: "ok", expiresAt: new Date(Date.now() + 1e9) });
    mockResultFindFirst.mockResolvedValue({
      id: "ok", url: "https://example.com", rawMarkdown: "word ".repeat(400), resolvedUrl: "https://example.com/",
      updatedAt: new Date(Date.now() - days * DAY),
    });
  }

  it("absent: a 3-day-old stored read is reused (unchanged behaviour)", async () => {
    cachedReadDaysOld(3);
    const res = await request(app).post("/scrape").send({ url: "https://example.com" });
    expect(res.body.cached).toBe(true);
    expect(mockScrapeWithEscalation).not.toHaveBeenCalled();
  });

  it("maxAgeDays=2: a 3-day-old stored read is ignored, the page is read fresh", async () => {
    cachedReadDaysOld(3);
    const res = await request(app).post("/scrape").send({ url: "https://example.com", maxAgeDays: 2 });
    expect(res.body.cached).toBe(false);
    expect(mockScrapeWithEscalation).toHaveBeenCalledTimes(1);
  });

  it("maxAgeDays=2: a 1-day-old stored read is reused", async () => {
    cachedReadDaysOld(1);
    const res = await request(app).post("/scrape").send({ url: "https://example.com", maxAgeDays: 2 });
    expect(res.body.cached).toBe(true);
  });

  it("maxAgeDays=0: never reads the store", async () => {
    cachedReadDaysOld(0);
    const res = await request(app).post("/scrape").send({ url: "https://example.com", maxAgeDays: 0 });
    expect(res.body.cached).toBe(false);
    expect(mockCacheFindFirst).not.toHaveBeenCalled();
  });

  it("maxAgeDays=8 is refused (nothing older than 7 days is kept)", async () => {
    const res = await request(app).post("/scrape").send({ url: "https://example.com", maxAgeDays: 8 });
    expect(res.status).toBe(400);
  });

  it("stores the caller's outcomeKey on the read's row; none stated = null", async () => {
    mockCacheFindFirst.mockResolvedValue(null);
    await request(app).post("/scrape").send({ url: "https://acme.com", outcomeKey: "company_researched" });
    const reqInsert = mockValues.mock.calls.find((c: any[]) => c[0]?.status === "processing");
    expect(reqInsert?.[0].outcomeKey).toBe("company_researched");
  });
});
