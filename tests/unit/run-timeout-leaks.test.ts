import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Stub env before imports
vi.stubEnv("RUNS_SERVICE_URL", "https://runs.test.org");
vi.stubEnv("RUNS_SERVICE_API_KEY", "test-api-key");
vi.stubEnv("SCRAPING_SERVICE_API_KEY", "test-scraping-key");

// Mock dependencies
vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      scrapeCache: { findFirst: vi.fn().mockResolvedValue(null) },
      scrapeResults: { findFirst: vi.fn() },
      extractCache: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error("DB insert exploded")),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error("DB insert exploded")),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("../../src/lib/key-client.js", () => ({
  resolveKey: vi.fn().mockResolvedValue({ key: "fake-key", keySource: "platform" }),
  KeyServiceError: class KeyServiceError extends Error {
    statusCode: number;
    constructor(msg: string, code: number) {
      super(msg);
      this.statusCode = code;
    }
  },
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({ sufficient: true }),
}));

const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-leak-test" });
const mockUpdateRunStatus = vi.fn().mockResolvedValue({ id: "run-leak-test", status: "failed" });
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: any[]) => mockCreateRun(...args),
  updateRunStatus: (...args: any[]) => mockUpdateRunStatus(...args),
  addCosts: (...args: any[]) => mockAddCosts(...args),
}));

vi.mock("../../src/lib/scrape-chain.js", () => ({
  scrapeWithEscalation: vi.fn().mockRejectedValue(new Error("chain exploded")),
}));

vi.mock("../../src/lib/firecrawl.js", () => ({
  normalizeUrl: (url: string) => url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""),
  scrapeUrl: vi.fn().mockRejectedValue(new Error("firecrawl exploded")),
  mapUrl: vi.fn().mockRejectedValue(new Error("map exploded")),
  extractUrl: vi.fn().mockRejectedValue(new Error("extract exploded")),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org_test";
    req.userId = "user_test";
    next();
  },
}));

// We need drizzle-orm exports for the route files
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gt: vi.fn(),
}));

const app = (await import("../../src/index.js")).default;

describe("Run timeout leaks — outer catch closes the run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-leak-test" });
    mockUpdateRunStatus.mockResolvedValue({ id: "run-leak-test", status: "failed" });
  });

  it("POST /scrape — outer catch calls updateRunStatus('failed') when error after createRun", async () => {
    const res = await request(app)
      .post("/scrape")
      .set("X-API-Key", "test-scraping-key")
      .send({ url: "https://example.com" });

    expect(res.status).toBe(500);

    // The run was created, then DB insert threw — outer catch must close the run
    expect(mockCreateRun).toHaveBeenCalled();
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      "run-leak-test",
      "failed",
      expect.objectContaining({ orgId: "org_test", userId: "user_test" })
    );
  });

  it("POST /map — outer catch calls updateRunStatus('failed') when error after createRun", async () => {
    const res = await request(app)
      .post("/map")
      .set("X-API-Key", "test-scraping-key")
      .send({ url: "https://example.com" });

    expect(res.status).toBe(500);

    expect(mockCreateRun).toHaveBeenCalled();
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      "run-leak-test",
      "failed",
      expect.objectContaining({ orgId: "org_test", userId: "user_test" })
    );
  });

  it("POST /extract — outer catch calls updateRunStatus('failed') when error after createRun", async () => {
    const res = await request(app)
      .post("/extract")
      .set("X-API-Key", "test-scraping-key")
      .send({ urls: ["https://example.com"] });

    expect(res.status).toBe(500);

    expect(mockCreateRun).toHaveBeenCalled();
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      "run-leak-test",
      "failed",
      expect.objectContaining({ orgId: "org_test", userId: "user_test" })
    );
  });

  it("POST /scrape — does NOT call updateRunStatus if createRun failed (no runId)", async () => {
    mockCreateRun.mockRejectedValue(new Error("runs service down"));

    const res = await request(app)
      .post("/scrape")
      .set("X-API-Key", "test-scraping-key")
      .send({ url: "https://example.com" });

    expect(res.status).toBe(500);
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
  });
});

describe("Fetch timeouts — AbortSignal present", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("scrape-do fetch() includes AbortSignal", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      capturedSignal = init?.signal;
      return new Response("# content", { status: 200 });
    }) as any;

    const { scrapeUrlWithScrapeDo } = await import("../../src/lib/scrape-do.js");
    await scrapeUrlWithScrapeDo("https://example.com", "token");

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("runs-client fetch() includes AbortSignal", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      capturedSignal = init?.signal;
      return { ok: true, json: () => Promise.resolve({ id: "run-1" }) } as any;
    }) as any;

    // Use importActual to bypass the vi.mock and get the real implementation
    const { createRun: createRunReal } = await vi.importActual<typeof import("../../src/lib/runs-client.js")>("../../src/lib/runs-client.js");
    await createRunReal({ taskName: "test" }, { orgId: "org", userId: "user" });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
