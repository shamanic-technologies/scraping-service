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
}

const DEFAULT_TIMEOUT_MS = 60000;
const RETRY_TIMEOUT_MS = 120000;

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
    const result = await firecrawl.scrapeUrl(url, {
      formats: options.formats || ["markdown"],
      onlyMainContent: options.onlyMainContent ?? true,
      includeTags: options.includeTags,
      excludeTags: options.excludeTags,
      waitFor: options.waitFor,
      timeout,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Scrape failed",
      };
    }

    return {
      success: true,
      markdown: result.markdown,
      html: result.html,
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
}

/**
 * Map a website to discover all URLs using Firecrawl
 */
export async function mapUrl(
  url: string,
  apiKey: string,
  options: MapOptions = {}
): Promise<MapResponse> {
  const firecrawl = new FirecrawlApp({ apiKey });

  try {
    const result = await firecrawl.mapUrl(url, {
      search: options.search,
      ignoreSitemap: options.ignoreSitemap,
      sitemapOnly: options.sitemapOnly,
      includeSubdomains: options.includeSubdomains ?? false,
      limit: options.limit || 100,
    });

    if (!result.success) {
      return {
        success: false,
        error: (result as any).error || "Map failed",
      };
    }

    return {
      success: true,
      urls: result.links || [],
    };
  } catch (error: any) {
    console.error("Firecrawl map error:", error);
    return {
      success: false,
      error: error.message || "Firecrawl map request failed",
    };
  }
}
