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

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
    query: {
      scrapeCache: { findFirst: (...a: any[]) => mockCacheFindFirst(...a) },
      scrapeResults: { findFirst: vi.fn() },
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

describe("POST /scrape — enrich + rawHtml contract", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheFindFirst.mockResolvedValue(null);
    app = makeApp();

    // First returning() = scrapeRequests insert, subsequent = scrapeResults insert
    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: "req-1" }]);
      return Promise.resolve([
        {
          id: "result-1",
          url: "https://example.com/contact",
          normalizedUrl: "example.com/contact",
          companyName: "Example",
          rawMarkdown: "# Example",
        },
      ]);
    });
  });

  it("AC#1: enrich:false + rawHtml → result.rawHtml populated, company fields null, no shared storage", async () => {
    const rawBody =
      '<a href="mailto:press@example.com">Press</a><span data-cfemail="0a0b">protected</span>';
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, html: rawBody },
      costName: "scrape-do-credit",
      levelName: "scrape-do-render-super",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 25,
    });

    const res = await request(app)
      .post("/scrape")
      .send({
        url: "https://example.com/contact",
        provider: "scrape-do",
        enrich: false,
        options: { formats: ["rawHtml"] },
      });

    expect(res.status).toBe(200);
    expect(res.body.result.rawHtml).toBe(rawBody);
    expect(res.body.result.rawHtml).toContain("mailto:");
    expect(res.body.result.rawHtml).toContain("data-cfemail");
    expect(res.body.result.companyName).toBeNull();
    expect(res.body.result.industry).toBeNull();

    // Raw-fetch mode must NOT touch the shared company-info cache / result store
    const resultsInsert = mockInsert.mock.calls.find((c) => c[0] === scrapeResults);
    const cacheInsert = mockInsert.mock.calls.find((c) => c[0] === scrapeCache);
    expect(resultsInsert).toBeUndefined();
    expect(cacheInsert).toBeUndefined();
  });

  it("AC#1: enrich:false skips the cache read (always fresh)", async () => {
    mockCacheFindFirst.mockResolvedValue({ resultId: "cached", expiresAt: new Date(Date.now() + 1e9) });
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, html: "<html></html>" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });

    const res = await request(app)
      .post("/scrape")
      .send({ url: "https://example.com/contact", enrich: false, options: { formats: ["rawHtml"] } });

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(mockCacheFindFirst).not.toHaveBeenCalled();
  });

  it("AC#2: enrich omitted → default path stores result + cache, rawHtml is null", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, markdown: "# Example" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });

    const res = await request(app).post("/scrape").send({ url: "https://example.com/contact" });

    expect(res.status).toBe(200);
    expect(res.body.result.rawHtml).toBeNull();
    // Existing behavior: shared result + cache upserts happen
    const resultsInsert = mockInsert.mock.calls.find((c) => c[0] === scrapeResults);
    const cacheInsert = mockInsert.mock.calls.find((c) => c[0] === scrapeCache);
    expect(resultsInsert).toBeTruthy();
    expect(cacheInsert).toBeTruthy();
    // Cache read happens in default mode
    expect(mockCacheFindFirst).toHaveBeenCalled();
  });

  it("AC#3: scrape.do cost declared on the forwarded run in raw-fetch mode", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, html: "<html></html>" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 5,
    });

    await request(app)
      .post("/scrape")
      .send({ url: "https://example.com/contact", enrich: false, options: { formats: ["rawHtml"] } });

    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockAddCosts.mock.calls[0][1]).toEqual([
      { costName: "scrape-do-credit", quantity: 5, costSource: "org" },
    ]);
  });

  it("AC#3: scrape.do cost declared on the forwarded run in default mode", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, markdown: "# Example" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });

    await request(app).post("/scrape").send({ url: "https://example.com/contact" });

    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockAddCosts.mock.calls[0][1]).toEqual([
      { costName: "scrape-do-credit", quantity: 1, costSource: "org" },
    ]);
  });

  it("render:true is forwarded to the escalation chain as forceRender", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, html: "<html></html>" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-render-super",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 25,
    });

    await request(app)
      .post("/scrape")
      .send({
        url: "https://example.com/contact",
        enrich: false,
        render: true,
        options: { formats: ["rawHtml"] },
      });

    expect(mockScrapeWithEscalation).toHaveBeenCalledTimes(1);
    expect(mockScrapeWithEscalation.mock.calls[0][0].forceRender).toBe(true);
  });

  it("render omitted → forceRender falsy", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, markdown: "# Example" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });

    await request(app).post("/scrape").send({ url: "https://example.com/contact" });

    expect(mockScrapeWithEscalation.mock.calls[0][0].forceRender).toBeFalsy();
  });
});
