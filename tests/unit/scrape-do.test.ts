import { describe, it, expect, vi, beforeEach } from "vitest";
import { scrapeUrlWithScrapeDo } from "../../src/lib/scrape-do.js";

describe("scrapeUrlWithScrapeDo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should call scrape.do API with correct params and return markdown", async () => {
    const mockMarkdown = "# Hello World\n\nSome content";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(mockMarkdown, { status: 200 })
    );

    const result = await scrapeUrlWithScrapeDo(
      "https://example.com",
      "test-token"
    );

    expect(result.success).toBe(true);
    expect(result.markdown).toBe(mockMarkdown);
    expect(result.metadata).toBeUndefined();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const calledUrl = new URL(fetchCall[0] as string);
    expect(calledUrl.origin).toBe("https://api.scrape.do");
    expect(calledUrl.searchParams.get("token")).toBe("test-token");
    expect(calledUrl.searchParams.get("url")).toBe("https://example.com");
    expect(calledUrl.searchParams.get("output")).toBe("markdown");
    expect(calledUrl.searchParams.get("timeout")).toBe("60000");
  });

  it("should set render=true and wait param when waitFor is provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("content", { status: 200 })
    );

    await scrapeUrlWithScrapeDo("https://example.com", "token", {
      waitFor: 3000,
    });

    const calledUrl = new URL(
      vi.mocked(globalThis.fetch).mock.calls[0][0] as string
    );
    expect(calledUrl.searchParams.get("render")).toBe("true");
    expect(calledUrl.searchParams.get("wait")).toBe("3000");
  });

  it("should use custom timeout when provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("content", { status: 200 })
    );

    await scrapeUrlWithScrapeDo("https://example.com", "token", {
      timeout: 30000,
    });

    const calledUrl = new URL(
      vi.mocked(globalThis.fetch).mock.calls[0][0] as string
    );
    expect(calledUrl.searchParams.get("timeout")).toBe("30000");
  });

  it("should return error on non-200 non-408 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );

    const result = await scrapeUrlWithScrapeDo(
      "https://example.com",
      "bad-token"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });

  it("should retry once on 408 timeout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First call: 408
    const err408 = new Error("Timeout") as Error & { statusCode: number };
    err408.statusCode = 408;
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 408 })
    );

    // Second call: success
    fetchSpy.mockResolvedValueOnce(
      new Response("# Retry content", { status: 200 })
    );

    // scrape-do returns a non-ok 408 which becomes an error result, not a thrown 408
    // The 408 retry logic only kicks in when fetch itself throws with statusCode 408
    // For scrape.do, a 408 response triggers the throw path
    const result = await scrapeUrlWithScrapeDo(
      "https://example.com",
      "token"
    );

    // The 408 response triggers the throw → retry path
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.markdown).toBe("# Retry content");

    // Verify retry used longer timeout
    const retryUrl = new URL(fetchSpy.mock.calls[1][0] as string);
    expect(retryUrl.searchParams.get("timeout")).toBe("120000");
  });

  it("should return error when both attempts fail on 408", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 408 }));
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 408 }));

    const result = await scrapeUrlWithScrapeDo(
      "https://example.com",
      "token"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("should return error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network error")
    );

    const result = await scrapeUrlWithScrapeDo(
      "https://example.com",
      "token"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Network error");
  });
});
