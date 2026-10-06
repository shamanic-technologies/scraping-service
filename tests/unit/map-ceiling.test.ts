import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mapUrl, homepageLinks, filterSiteLinks, MAP_CEILING_MS } from "../../src/lib/firecrawl.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("mapUrl ceiling (dubizzle.com took 98 s on 2026-10-06)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("hands Firecrawl a ceiling of ~18 s", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { success: true, links: ["https://a.com"] }));
    await mapUrl("https://a.com", "k", { limit: 100, includeSubdomains: true });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.timeout).toBe(MAP_CEILING_MS);
    expect(MAP_CEILING_MS).toBeLessThanOrEqual(20000);
    expect(body.limit).toBe(100);
    expect(body.includeSubdomains).toBe(true);
  });

  it("returns urls on a normal map, unchanged", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { success: true, links: ["https://a.com", "https://a.com/about"] }));
    const r = await mapUrl("https://a.com", "k");
    expect(r).toEqual({ success: true, urls: ["https://a.com", "https://a.com/about"] });
  });

  it("flags a 408 MAP_TIMEOUT as timedOut (the SDK reported it as a 500)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(408, { success: false, code: "MAP_TIMEOUT", error: "The map operation timed out" }));
    const r = await mapUrl("https://dubizzle.com", "k");
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("does not flag a real failure as timedOut", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(429, { success: false, error: "Rate limited" }));
    const r = await mapUrl("https://a.com", "k");
    expect(r).toEqual({ success: false, error: "Rate limited" });
  });

  it("treats a client-side abort as timedOut", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    fetchSpy.mockRejectedValueOnce(err);
    const r = await mapUrl("https://a.com", "k");
    expect(r.timedOut).toBe(true);
  });
});

describe("homepageLinks fallback", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("scrapes the homepage in links format and keeps the site's own links", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          links: [
            "https://www.dubizzle.com/about/",
            "https://www.dubizzle.com/contact/",
            "https://dubai.dubizzle.com/motors/",
            "https://twitter.com/dubizzle",
          ],
        },
      })
    );
    const r = await homepageLinks("https://dubizzle.com", "k", { includeSubdomains: true, limit: 100 });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.formats).toEqual(["links"]);
    expect(r.success).toBe(true);
    expect(r.urls).toEqual([
      "https://dubizzle.com/",
      "https://www.dubizzle.com/about/",
      "https://www.dubizzle.com/contact/",
      "https://dubai.dubizzle.com/motors/",
    ]);
  });

  it("fails loud when the scrape fails", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { success: false, error: "boom" }));
    const r = await homepageLinks("https://a.com", "k");
    expect(r).toEqual({ success: false, error: "boom" });
  });
});

describe("filterSiteLinks", () => {
  it("drops subdomains unless includeSubdomains, strips fragments, dedupes, caps", () => {
    const links = ["https://a.com/x#top", "https://a.com/x", "https://blog.a.com/p", "mailto:hi@a.com", "/rel"];
    expect(filterSiteLinks("https://a.com", links)).toEqual(["https://a.com/", "https://a.com/x", "https://a.com/rel"]);
    expect(filterSiteLinks("https://a.com", links, { includeSubdomains: true, limit: 3 })).toEqual([
      "https://a.com/",
      "https://a.com/x",
      "https://blog.a.com/p",
    ]);
  });

  it("does not treat a look-alike domain as a subdomain", () => {
    expect(filterSiteLinks("https://a.com", ["https://evila.com/x"], { includeSubdomains: true })).toEqual(["https://a.com/"]);
  });
});
