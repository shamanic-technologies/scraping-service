import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock scrape-do
const mockScrapeUrlWithScrapeDo = vi.fn();
vi.mock("../../src/lib/scrape-do.js", () => ({
  scrapeUrlWithScrapeDo: (...args: any[]) => mockScrapeUrlWithScrapeDo(...args),
}));

// Mock firecrawl
const mockScrapeUrl = vi.fn();
vi.mock("../../src/lib/firecrawl.js", () => ({
  scrapeUrl: (...args: any[]) => mockScrapeUrl(...args),
}));

import { scrapeWithEscalation, ScrapeChainParams } from "../../src/lib/scrape-chain.js";

const baseParams: ScrapeChainParams = {
  url: "https://example.com",
  scrapeDoApiKey: "test-key",
  options: {},
  resolveFirecrawlKey: vi.fn().mockResolvedValue({ key: "fc-key", keySource: "platform" as const }),
};

describe("scrapeWithEscalation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return immediately when level 1 (basic) succeeds", async () => {
    mockScrapeUrlWithScrapeDo.mockResolvedValueOnce({
      success: true,
      markdown: "# Hello",
    });

    const result = await scrapeWithEscalation(baseParams, "platform");

    expect(result.response.success).toBe(true);
    expect(result.costName).toBe("scrape-do-scrape-credit");
    expect(result.levelName).toBe("scrape-do-basic");
    expect(result.provider).toBe("scrape-do");
    expect(result.keySource).toBe("platform");

    expect(mockScrapeUrlWithScrapeDo).toHaveBeenCalledTimes(1);
    expect(mockScrapeUrlWithScrapeDo).toHaveBeenCalledWith(
      "https://example.com", "test-key", {}, undefined
    );
    expect(mockScrapeUrl).not.toHaveBeenCalled();
    expect(baseParams.resolveFirecrawlKey).not.toHaveBeenCalled();
  });

  it("should escalate to level 2 (render) when level 1 fails", async () => {
    mockScrapeUrlWithScrapeDo
      .mockResolvedValueOnce({ success: false, error: "403 Forbidden" })
      .mockResolvedValueOnce({ success: true, markdown: "# Rendered" });

    const result = await scrapeWithEscalation(baseParams, "platform");

    expect(result.response.success).toBe(true);
    expect(result.costName).toBe("scrape-do-render-credit");
    expect(result.levelName).toBe("scrape-do-render");

    expect(mockScrapeUrlWithScrapeDo).toHaveBeenCalledTimes(2);
    // Verify render overrides on second call
    expect(mockScrapeUrlWithScrapeDo.mock.calls[1][3]).toEqual({
      render: true, waitUntil: "networkidle0", customWait: 3000,
    });
  });

  it("should escalate to level 3 (render+super) when levels 1-2 fail", async () => {
    mockScrapeUrlWithScrapeDo
      .mockResolvedValueOnce({ success: false, error: "500 error" })
      .mockResolvedValueOnce({ success: false, error: "500 error" })
      .mockResolvedValueOnce({ success: true, markdown: "# Super" });

    const result = await scrapeWithEscalation(baseParams, "platform");

    expect(result.response.success).toBe(true);
    expect(result.costName).toBe("scrape-do-render-super-credit");
    expect(result.levelName).toBe("scrape-do-render-super");

    expect(mockScrapeUrlWithScrapeDo).toHaveBeenCalledTimes(3);
    expect(mockScrapeUrlWithScrapeDo.mock.calls[2][3]).toEqual({
      render: true, super: true, waitUntil: "networkidle0", customWait: 3000,
    });
  });

  it("should fall back to firecrawl when all scrape-do levels fail", async () => {
    mockScrapeUrlWithScrapeDo
      .mockResolvedValue({ success: false, error: "scrape-do failed" });
    mockScrapeUrl
      .mockResolvedValueOnce({ success: true, markdown: "# Firecrawl" });

    const result = await scrapeWithEscalation(baseParams, "platform");

    expect(result.response.success).toBe(true);
    expect(result.costName).toBe("firecrawl-scrape-credit");
    expect(result.levelName).toBe("firecrawl-fallback");
    expect(result.provider).toBe("firecrawl");
    expect(result.keySource).toBe("platform");

    expect(mockScrapeUrlWithScrapeDo).toHaveBeenCalledTimes(3);
    expect(baseParams.resolveFirecrawlKey).toHaveBeenCalledTimes(1);
    expect(mockScrapeUrl).toHaveBeenCalledWith("https://example.com", "fc-key", {});
  });

  it("should return failure when all 4 levels fail", async () => {
    mockScrapeUrlWithScrapeDo
      .mockResolvedValue({ success: false, error: "scrape-do failed" });
    mockScrapeUrl
      .mockResolvedValueOnce({ success: false, error: "firecrawl failed" });

    const result = await scrapeWithEscalation(baseParams, "platform");

    expect(result.response.success).toBe(false);
    expect(result.response.error).toBe("firecrawl failed");
    expect(result.levelName).toBe("all-failed");
  });

  it("should skip firecrawl fallback gracefully when key resolution fails", async () => {
    mockScrapeUrlWithScrapeDo
      .mockResolvedValue({ success: false, error: "scrape-do failed" });

    const params: ScrapeChainParams = {
      ...baseParams,
      resolveFirecrawlKey: vi.fn().mockRejectedValue(new Error("Key not found")),
    };

    const result = await scrapeWithEscalation(params, "platform");

    expect(result.response.success).toBe(false);
    expect(result.levelName).toBe("all-failed");
    expect(mockScrapeUrl).not.toHaveBeenCalled();
  });

  it("should propagate firecrawl keySource when firecrawl fallback succeeds with org key", async () => {
    mockScrapeUrlWithScrapeDo
      .mockResolvedValue({ success: false, error: "failed" });
    mockScrapeUrl
      .mockResolvedValueOnce({ success: true, markdown: "# FC" });

    const params: ScrapeChainParams = {
      ...baseParams,
      resolveFirecrawlKey: vi.fn().mockResolvedValue({ key: "user-fc-key", keySource: "org" }),
    };

    const result = await scrapeWithEscalation(params, "platform");

    expect(result.keySource).toBe("org");
    expect(result.provider).toBe("firecrawl");
  });

  it("should pass caller options through to every scrape-do level", async () => {
    const options = { waitFor: 5000, timeout: 30000 };
    mockScrapeUrlWithScrapeDo
      .mockResolvedValueOnce({ success: false, error: "fail" })
      .mockResolvedValueOnce({ success: true, markdown: "ok" });

    await scrapeWithEscalation({ ...baseParams, options }, "platform");

    // Both calls get the same caller options
    expect(mockScrapeUrlWithScrapeDo.mock.calls[0][2]).toEqual(options);
    expect(mockScrapeUrlWithScrapeDo.mock.calls[1][2]).toEqual(options);
  });
});
