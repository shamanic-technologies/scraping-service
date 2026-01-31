import FirecrawlApp from "@mendable/firecrawl-js";

let firecrawlClient: FirecrawlApp | null = null;

export function getFirecrawl(): FirecrawlApp {
  if (!firecrawlClient) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new Error("FIRECRAWL_API_KEY is not set");
    }
    firecrawlClient = new FirecrawlApp({ apiKey });
  }
  return firecrawlClient;
}

export interface ScrapeOptions {
  formats?: ("markdown" | "html" | "rawHtml" | "links" | "screenshot")[];
  onlyMainContent?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  waitFor?: number;
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

/**
 * Scrape a URL using Firecrawl
 */
export async function scrapeUrl(
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResponse> {
  const firecrawl = getFirecrawl();

  try {
    const result = await firecrawl.scrapeUrl(url, {
      formats: options.formats || ["markdown"],
      onlyMainContent: options.onlyMainContent ?? true,
      includeTags: options.includeTags,
      excludeTags: options.excludeTags,
      waitFor: options.waitFor,
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
  } catch (error: any) {
    console.error("Firecrawl error:", error);
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
  options: MapOptions = {}
): Promise<MapResponse> {
  const firecrawl = getFirecrawl();

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
