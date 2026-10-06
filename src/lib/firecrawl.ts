import FirecrawlApp from "@mendable/firecrawl-js";

export interface ScrapeOptions {
  formats?: ("markdown" | "html" | "rawHtml" | "links" | "screenshot")[];
  onlyMainContent?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  waitFor?: number;
  timeout?: number;
}

export interface ScrapeResponse {
  success: boolean;
  markdown?: string;
  html?: string;
  metadata?: {
    title?: string;
    description?: string;
    language?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
    [key: string]: unknown;
  };
  error?: string;
  requestCost?: number;
}

const DEFAULT_TIMEOUT_MS = 60000;
const RETRY_TIMEOUT_MS = 120000;
const SDK_ABORT_TIMEOUT_MS = 150000;
const FETCH_TIMEOUT_MS = 10000;

/**
 * Scrape a URL using Firecrawl.
 * On a 408 timeout, automatically retries once with a longer timeout.
 */
export async function scrapeUrl(
  url: string,
  apiKey: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResponse> {
  const firecrawl = new FirecrawlApp({ apiKey });
  const baseTimeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  const attempt = async (timeout: number): Promise<ScrapeResponse> => {
    const result = await Promise.race([
      firecrawl.scrapeUrl(url, {
        formats: options.formats || ["markdown"],
        onlyMainContent: options.onlyMainContent ?? true,
        includeTags: options.includeTags,
        excludeTags: options.excludeTags,
        waitFor: options.waitFor,
        timeout,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Firecrawl SDK timed out after ${SDK_ABORT_TIMEOUT_MS}ms`)), SDK_ABORT_TIMEOUT_MS)
      ),
    ]);

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Scrape failed",
      };
    }

    // When the caller requested rawHtml, prefer Firecrawl's raw HTML field
    // (markdown/cleaned html strips mailto: and data-cfemail attributes).
    const wantsRawHtml = options.formats?.includes("rawHtml") ?? false;

    return {
      success: true,
      markdown: result.markdown,
      html: wantsRawHtml ? ((result as any).rawHtml ?? result.html) : result.html,
      metadata: result.metadata,
    };
  };

  try {
    return await attempt(baseTimeout);
  } catch (error: any) {
    if (error.statusCode === 408) {
      console.warn(
        `[scraping-service] Timeout scraping ${url} (${baseTimeout}ms), retrying with ${RETRY_TIMEOUT_MS}ms`
      );
      try {
        return await attempt(RETRY_TIMEOUT_MS);
      } catch (retryError: any) {
        console.error("[scraping-service] Retry also failed:", retryError);
        return {
          success: false,
          error: retryError.message || "Firecrawl request timed out after retry",
        };
      }
    }
    console.error("[scraping-service] Firecrawl error:", error);
    return {
      success: false,
      error: error.message || "Firecrawl request failed",
    };
  }
}

/**
 * Normalize a URL for cache lookup
 * Removes trailing slash, www, protocol variations
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.replace(/^www\./, "");
    let path = parsed.pathname.replace(/\/$/, "") || "";
    return `${host}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  }
}

// --- Extract (LLM extraction via dedicated /v1/extract API) ---

export interface ExtractResult {
  success: boolean;
  authors?: { firstName: string; lastName: string }[];
  publishedAt?: string | null;
  tokensUsed?: number;
  error?: string;
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    authors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
        },
        required: ["firstName", "lastName"],
      },
    },
    publishedAt: { type: ["string", "null"] },
  },
  required: ["authors", "publishedAt"],
};

const EXTRACT_PROMPT =
  "Extract the article author(s) and the publication date. " +
  "For authors, return only real human names (not organization names like 'Reuters Staff' or 'AP News'). " +
  "Split each name into firstName and lastName. " +
  "For publishedAt, return an ISO 8601 date string, or null if not found.";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const EXTRACT_POLL_INTERVAL_MS = 1000;
const EXTRACT_MAX_POLLS = 60;

/**
 * Extract structured article metadata (authors, publishedAt) from a URL
 * using Firecrawl's dedicated /v1/extract API.
 *
 * Uses raw HTTP instead of the SDK because the SDK drops `tokensUsed`
 * from the response, which we need for cost tracking.
 */
export async function extractUrl(
  url: string,
  apiKey: string
): Promise<ExtractResult> {
  try {
    // Start extract job
    const startRes = await fetch(`${FIRECRAWL_API_URL}/v1/extract`, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        urls: [url],
        prompt: EXTRACT_PROMPT,
        schema: EXTRACT_SCHEMA,
      }),
    });

    if (!startRes.ok) {
      const errBody = await startRes.text();
      return {
        success: false,
        error: `Firecrawl extract start failed (${startRes.status}): ${errBody}`,
      };
    }

    const startData = (await startRes.json()) as { success: boolean; id: string; error?: string };
    if (!startData.success || !startData.id) {
      return {
        success: false,
        error: startData.error || "Firecrawl extract failed to start",
      };
    }

    // Poll for completion
    const jobId = startData.id;
    for (let i = 0; i < EXTRACT_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, EXTRACT_POLL_INTERVAL_MS));

      const statusRes = await fetch(`${FIRECRAWL_API_URL}/v1/extract/${jobId}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!statusRes.ok) {
        continue; // Retry on transient errors
      }

      const status = (await statusRes.json()) as {
        status: string;
        success?: boolean;
        data?: { authors?: { firstName: string; lastName: string }[]; publishedAt?: string | null };
        tokensUsed?: number;
        error?: string;
      };

      if (status.status === "completed") {
        if (!status.success) {
          return { success: false, error: status.error || "Extract failed" };
        }
        return {
          success: true,
          authors: status.data?.authors || [],
          publishedAt: status.data?.publishedAt || null,
          tokensUsed: status.tokensUsed,
        };
      }

      if (status.status === "failed" || status.status === "cancelled") {
        return { success: false, error: status.error || `Extract ${status.status}` };
      }
    }

    return { success: false, error: "Extract timed out" };
  } catch (error: any) {
    console.error("Firecrawl extract error:", error);
    return {
      success: false,
      error: error.message || "Firecrawl extract request failed",
    };
  }
}

export interface MapOptions {
  search?: string;
  ignoreSitemap?: boolean;
  sitemapOnly?: boolean;
  includeSubdomains?: boolean;
  limit?: number;
}

export interface MapResponse {
  success: boolean;
  urls?: string[];
  error?: string;
  /** True when Firecrawl stopped the map at our ceiling (HTTP 408 MAP_TIMEOUT). Firecrawl bills nothing for it. */
  timedOut?: boolean;
}

/**
 * Server-side ceiling handed to Firecrawl's /v1/map. Measured 2026-10-06: maps
 * of big sites that Firecrawl has not indexed yet run 35-100 s (dubizzle.com 98 s,
 * kijiji.ca 44 s, gumtree.com 36 s) while 148 of 160 prod maps over 30 days took
 * under 10 s. Past the ceiling Firecrawl answers 408 MAP_TIMEOUT with NO partial
 * URLs (and no credit charged), so the route falls back to the homepage's links.
 */
export const MAP_CEILING_MS = 18000;
/** Client-side abort, a little past the ceiling, in case Firecrawl never answers. */
const MAP_ABORT_MS = MAP_CEILING_MS + 5000;
/** Ceiling for the homepage-links fallback scrape (measured 0.6-1.5 s on big sites). */
export const HOMEPAGE_LINKS_TIMEOUT_MS = 8000;

/**
 * Map a website to discover URLs using Firecrawl, bounded by MAP_CEILING_MS.
 *
 * Raw HTTP instead of the SDK: the SDK rewraps every non-200 as a status-500
 * FirecrawlError, so a 408 MAP_TIMEOUT could not be told apart from a real failure.
 */
export async function mapUrl(
  url: string,
  apiKey: string,
  options: MapOptions = {}
): Promise<MapResponse> {
  try {
    const res = await fetch(`${FIRECRAWL_API_URL}/v1/map`, {
      method: "POST",
      signal: AbortSignal.timeout(MAP_ABORT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        search: options.search,
        ignoreSitemap: options.ignoreSitemap,
        sitemapOnly: options.sitemapOnly,
        includeSubdomains: options.includeSubdomains ?? false,
        limit: options.limit,
        timeout: MAP_CEILING_MS,
      }),
    });

    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; links?: string[]; code?: string; error?: string }
      | null;

    if (res.status === 408 || body?.code === "MAP_TIMEOUT") {
      console.warn(`[scraping-service] Firecrawl map hit the ${MAP_CEILING_MS}ms ceiling for ${url}`);
      return { success: false, timedOut: true, error: body?.error || "Map timed out" };
    }

    if (!res.ok || !body?.success) {
      return {
        success: false,
        error: body?.error || `Firecrawl map failed (${res.status})`,
      };
    }

    return {
      success: true,
      urls: body.links || [],
    };
  } catch (error: any) {
    if (error?.name === "TimeoutError") {
      console.warn(`[scraping-service] Firecrawl map gave no answer within ${MAP_ABORT_MS}ms for ${url}`);
      return { success: false, timedOut: true, error: `Map timed out after ${MAP_ABORT_MS}ms` };
    }
    console.error("Firecrawl map error:", error);
    return {
      success: false,
      error: error.message || "Firecrawl map request failed",
    };
  }
}

function siteHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Keep the links that belong to the mapped site (same host, or a subdomain of it
 * when includeSubdomains), drop fragments, dedupe, then cap at limit SHALLOW
 * FIRST: main host before subdomains, fewer path segments first (a query string
 * counts as one more), homepage order otherwise. A marketplace homepage carries
 * hundreds of listing links and its company pages (/about, /contact, /business)
 * sit near the end of the page, so a cap in page order cut them (dubizzle.com:
 * 225 links, /about at position ~150).
 */
export function filterSiteLinks(
  rootUrl: string,
  links: string[],
  options: { includeSubdomains?: boolean; limit?: number } = {}
): string[] {
  const root = new URL(rootUrl);
  const base = siteHost(root.hostname);
  const seen = new Set<string>();
  const kept: { href: string; subdomain: boolean; depth: number; index: number }[] = [];

  for (const raw of [root.href, ...links]) {
    let u: URL;
    try {
      u = new URL(raw, root);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = siteHost(u.hostname);
    const subdomain = host !== base;
    if (subdomain && !(options.includeSubdomains === true && host.endsWith(`.${base}`))) continue;
    u.hash = "";
    const href = u.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const depth = u.pathname.split("/").filter(Boolean).length + (u.search ? 1 : 0);
    kept.push({ href, subdomain, depth, index: kept.length });
  }

  kept.sort(
    (a, b) =>
      Number(a.subdomain) - Number(b.subdomain) || a.depth - b.depth || a.index - b.index
  );
  const ordered = kept.map((k) => k.href);
  return options.limit === undefined ? ordered : ordered.slice(0, options.limit);
}

/**
 * Fallback when the map hits its ceiling: one Firecrawl scrape of the homepage
 * in `links` format. A homepage links to the company pages a caller wants
 * (about, pricing, contact, business, careers) and answers in ~1 s even on the
 * biggest marketplaces. Costs one Firecrawl scrape credit.
 */
export async function homepageLinks(
  url: string,
  apiKey: string,
  options: { includeSubdomains?: boolean; limit?: number } = {}
): Promise<MapResponse> {
  try {
    const res = await fetch(`${FIRECRAWL_API_URL}/v1/scrape`, {
      method: "POST",
      signal: AbortSignal.timeout(HOMEPAGE_LINKS_TIMEOUT_MS + 5000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url, formats: ["links"], timeout: HOMEPAGE_LINKS_TIMEOUT_MS }),
    });

    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: { links?: string[] }; error?: string }
      | null;

    if (!res.ok || !body?.success) {
      return {
        success: false,
        error: body?.error || `Firecrawl homepage links scrape failed (${res.status})`,
      };
    }

    return { success: true, urls: filterSiteLinks(url, body.data?.links || [], options) };
  } catch (error: any) {
    console.error("Firecrawl homepage links error:", error);
    return {
      success: false,
      error: error.message || "Firecrawl homepage links request failed",
    };
  }
}
