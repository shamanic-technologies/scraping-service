import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Firecrawl SDK
const mockScrapeUrl = vi.fn();
vi.mock("@mendable/firecrawl-js", () => ({
  default: vi.fn().mockImplementation(() => ({
    scrapeUrl: mockScrapeUrl,
  })),
}));

import { scrapeUrl } from "../../src/lib/firecrawl.js";

describe("scrapeUrl timeout and retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes default 60s timeout to Firecrawl", async () => {
    mockScrapeUrl.mockResolvedValueOnce({
      success: true,
      markdown: "# Hello",
      metadata: { title: "Test" },
    });

    await scrapeUrl("https://example.com", "test-key");

    expect(mockScrapeUrl).toHaveBeenCalledWith("https://example.com", {
      formats: ["markdown"],
      onlyMainContent: true,
      includeTags: undefined,
      excludeTags: undefined,
      waitFor: undefined,
      timeout: 60000,
    });
  });

  it("passes custom timeout when specified", async () => {
    mockScrapeUrl.mockResolvedValueOnce({
      success: true,
      markdown: "# Hello",
      metadata: {},
    });

    await scrapeUrl("https://example.com", "test-key", { timeout: 90000 });

    expect(mockScrapeUrl).toHaveBeenCalledWith("https://example.com", expect.objectContaining({
      timeout: 90000,
    }));
  });

  it("retries with 120s timeout on 408 error", async () => {
    const timeoutError = new Error("Timed out");
    (timeoutError as any).statusCode = 408;

    mockScrapeUrl
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        success: true,
        markdown: "# Retry worked",
        metadata: { title: "Retried" },
      });

    const result = await scrapeUrl("https://slow-site.com", "test-key");

    expect(mockScrapeUrl).toHaveBeenCalledTimes(2);
    // First call: default 60s
    expect(mockScrapeUrl.mock.calls[0][1].timeout).toBe(60000);
    // Retry call: 120s
    expect(mockScrapeUrl.mock.calls[1][1].timeout).toBe(120000);
    expect(result.success).toBe(true);
    expect(result.markdown).toBe("# Retry worked");
  });

  it("returns error when retry also times out", async () => {
    const timeoutError = new Error("Timed out");
    (timeoutError as any).statusCode = 408;

    mockScrapeUrl
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);

    const result = await scrapeUrl("https://very-slow-site.com", "test-key");

    expect(mockScrapeUrl).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out");
  });

  it("does not retry on non-408 errors", async () => {
    const otherError = new Error("Server error");
    (otherError as any).statusCode = 500;

    mockScrapeUrl.mockRejectedValueOnce(otherError);

    const result = await scrapeUrl("https://broken-site.com", "test-key");

    expect(mockScrapeUrl).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Server error");
  });
});
