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

// Capture the outcome declaration the route hands to runs-service
const mockDeclareInBackground = vi.fn().mockResolvedValue(true);
vi.mock("../../src/lib/outcome-declaration.js", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    declareRunOutcomesInBackground: (...args: any[]) => mockDeclareInBackground(...args),
    declareScrapeOutcome: (key: any, url: string, runId: any, identity: any) => {
      if (!key || !runId) return;
      const body = actual.scrapeDeclaration(key, url);
      if (body) mockDeclareInBackground(runId, body, identity);
    },
  };
});

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

describe("POST /scrape — outcome declaration (COST-ACCOUNTING-1023)", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheFindFirst.mockResolvedValue(null);
    mockCreateRun.mockResolvedValue({ id: "own-run-id" });
    app = makeApp();
    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: "req-1" }]);
      return Promise.resolve([{ id: "result-1", url: "https://www.Acme.com/about", rawMarkdown: "# Acme" }]);
    });
    mockScrapeWithEscalation.mockResolvedValue({
      response: { success: true, markdown: "# Acme" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });
  });

  it("outcomeKey company_researched → the scrape run produces it on lead-service's company key", async () => {
    const res = await request(app)
      .post("/scrape")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .send({ url: "https://www.Acme.com/about", outcomeKey: "company_researched" });

    expect(res.status).toBe(200);
    expect(mockDeclareInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeclareInBackground).toHaveBeenCalledWith(
      "own-run-id",
      { produced: [{ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "acme.com" }], consumed: [] },
      { orgId: "org-1", userId: "user-1" }
    );
  });

  it("raw-fetch mode declares too (reading the site is the research)", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: true, html: "<html></html>" },
      costName: "scrape-do-credit",
      levelName: "scrape-do-basic",
      provider: "scrape-do",
      keySource: "org",
      requestCost: 1,
    });
    await request(app)
      .post("/scrape")
      .send({ url: "https://acme.com/contact", enrich: false, outcomeKey: "company_researched" });
    expect(mockDeclareInBackground.mock.calls[0][1].produced[0].subjectId).toBe("acme.com");
  });

  it("outcomeKey omitted (brand setup) → nothing declared, cost rolls into the caller's run", async () => {
    await request(app).post("/scrape").send({ url: "https://acme.com/about" });
    expect(mockDeclareInBackground).not.toHaveBeenCalled();
  });

  it("failed scrape → nothing declared (a failure is never an outcome)", async () => {
    mockScrapeWithEscalation.mockResolvedValueOnce({
      response: { success: false, error: "boom" },
      costName: "scrape-do-credit",
      provider: "scrape-do",
      keySource: "org",
    });
    const res = await request(app).post("/scrape").send({ url: "https://acme.com", outcomeKey: "company_researched" });
    expect(res.status).toBe(500);
    expect(mockDeclareInBackground).not.toHaveBeenCalled();
  });

  it("cache hit → no spend, nothing declared", async () => {
    mockCacheFindFirst.mockResolvedValueOnce({ resultId: "r" });
    const { db } = await import("../../src/db/index.js");
    (db.query.scrapeResults.findFirst as any).mockResolvedValueOnce({ id: "r", url: "https://acme.com", rawMarkdown: "x".repeat(2000) });
    const res = await request(app).post("/scrape").send({ url: "https://acme.com", outcomeKey: "company_researched" });
    expect(res.body.cached).toBe(true);
    expect(mockDeclareInBackground).not.toHaveBeenCalled();
  });

  it("unknown outcomeKey → 400, nothing scraped", async () => {
    const res = await request(app).post("/scrape").send({ url: "https://acme.com", outcomeKey: "lead_found" });
    expect(res.status).toBe(400);
    expect(mockScrapeWithEscalation).not.toHaveBeenCalled();
  });
});
