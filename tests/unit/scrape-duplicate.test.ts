import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before imports
vi.mock("../../src/lib/key-client.js", () => ({
  decryptByokKey: vi.fn().mockResolvedValue({ provider: "firecrawl", key: "test-key" }),
  KeyServiceError: class KeyServiceError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = "KeyServiceError";
    }
  },
}));

// Mock firecrawl before imports
vi.mock("../../src/lib/firecrawl.js", () => ({
  scrapeUrl: vi.fn(),
  normalizeUrl: vi.fn((url: string) =>
    url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()
  ),
}));

// Mock db module with chainable insert/update/query
const mockReturning = vi.fn();
const mockOnConflictDoUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  onConflictDoUpdate: mockOnConflictDoUpdate,
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockSet = vi.fn(() => ({ where: vi.fn() }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
    query: {
      scrapeCache: { findFirst: vi.fn().mockResolvedValue(null) },
      scrapeResults: { findFirst: vi.fn() },
    },
  },
}));

import request from "supertest";
import express from "express";
import scrapeRoutes from "../../src/routes/scrape.js";
import { scrapeUrl } from "../../src/lib/firecrawl.js";
import { scrapeResults, scrapeCache } from "../../src/db/schema.js";

describe("POST /scrape - duplicate URL handling", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();

    app = express();
    app.use(express.json());
    // Skip auth
    app.use((req, res, next) => next());
    app.use(scrapeRoutes);

    // Default: insert returns a result
    const fakeResult = {
      id: "result-1",
      url: "https://mcpfactory.org",
      normalizedUrl: "mcpfactory.org",
      companyName: "MCP Factory",
      description: "Test",
      industry: null,
    };
    mockReturning.mockResolvedValue([
      { id: "req-1", sourceService: "test", url: "https://mcpfactory.org" },
    ]);

    // First call = scrapeRequests insert, second = scrapeResults insert
    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve([{ id: "req-1" }]);
      }
      return Promise.resolve([fakeResult]);
    });
  });

  it("should use onConflictDoUpdate when inserting scrape results", async () => {
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      success: true,
      markdown: "# MCP Factory",
      metadata: { title: "MCP Factory", description: "Test" },
    } as any);

    const response = await request(app).post("/scrape").send({
      url: "https://mcpfactory.org",
      sourceOrgId: "org_test",
    });

    expect(response.status).toBe(200);

    // Verify scrapeResults insert was called with onConflictDoUpdate
    const scrapeResultsInsertCall = mockInsert.mock.calls.find(
      (call) => call[0] === scrapeResults
    );
    expect(scrapeResultsInsertCall).toBeTruthy();
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: scrapeResults.normalizedUrl,
        set: expect.objectContaining({
          companyName: "MCP Factory",
          description: "Test",
        }),
      })
    );
  });

  it("should use onConflictDoUpdate for scrape cache too", async () => {
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      success: true,
      markdown: "# MCP Factory",
      metadata: { title: "MCP Factory" },
    } as any);

    await request(app).post("/scrape").send({
      url: "https://mcpfactory.org",
      sourceOrgId: "org_test",
    });

    // Verify scrapeCache insert was called with onConflictDoUpdate
    const scrapeCacheInsertCall = mockInsert.mock.calls.find(
      (call) => call[0] === scrapeCache
    );
    expect(scrapeCacheInsertCall).toBeTruthy();
    expect(mockOnConflictDoUpdate).toHaveBeenCalled();
  });
});
