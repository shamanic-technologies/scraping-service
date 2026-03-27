import FirecrawlApp from "@mendable/firecrawl-js";

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
  apiKey: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResponse> {
  const firecrawl = new FirecrawlApp({ apiKey });

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

// --- Extract (metadata parsing from scrape — no LLM) ---

export interface ExtractResult {
  success: boolean;
  authors?: { firstName: string; lastName: string }[];
  publishedAt?: string | null;
  error?: string;
}

/**
 * Known organization / non-human author names to filter out.
 */
const ORG_AUTHOR_PATTERNS = [
  /\bstaff\b/i,
  /\beditor(s|ial)?\b/i,
  /\bnewsroom\b/i,
  /\bteam\b/i,
  /\bdesk\b/i,
  /\bwire\b/i,
  /\bpress\b/i,
  /\bassociated press\b/i,
  /^reuters$/i,
  /^ap$/i,
  /^afp$/i,
];

/**
 * Split a full name string into firstName / lastName.
 */
export function splitAuthorName(name: string): { firstName: string; lastName: string } | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Filter out organization names
  if (ORG_AUTHOR_PATTERNS.some((p) => p.test(trimmed))) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

/**
 * Parse authors from scrape metadata.
 * Looks at common meta tag keys that Firecrawl returns.
 */
export function parseAuthorsFromMetadata(
  metadata: Record<string, unknown>
): { firstName: string; lastName: string }[] {
  // Keys where article authors are commonly found in Firecrawl metadata
  const authorKeys = [
    "author",
    "article:author",
    "og:article:author",
    "dc.creator",
    "citation_author",
  ];

  const rawAuthors: string[] = [];
  for (const key of authorKeys) {
    const val = metadata[key];
    if (typeof val === "string" && val.trim()) {
      rawAuthors.push(val.trim());
      break; // Use the first key that has a value
    }
    if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === "string" && v.trim()) rawAuthors.push(v.trim());
      }
      if (rawAuthors.length > 0) break;
    }
  }

  // Also check JSON-LD if embedded in metadata
  const jsonLd = metadata["jsonLd"] || metadata["json-ld"] || metadata["jsonld"];
  if (jsonLd && typeof jsonLd === "object") {
    const ld = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
    for (const item of ld) {
      const ldObj = item as Record<string, unknown>;
      if (ldObj["@type"] === "Article" || ldObj["@type"] === "NewsArticle" || ldObj["@type"] === "BlogPosting") {
        const author = ldObj["author"];
        if (typeof author === "string") {
          rawAuthors.push(author);
        } else if (Array.isArray(author)) {
          for (const a of author) {
            if (typeof a === "string") rawAuthors.push(a);
            else if (a && typeof a === "object" && typeof (a as any).name === "string") {
              rawAuthors.push((a as any).name);
            }
          }
        } else if (author && typeof author === "object" && typeof (author as any).name === "string") {
          rawAuthors.push((author as any).name);
        }
      }
    }
  }

  // Some author fields contain comma-separated or "and"-separated lists
  const expanded: string[] = [];
  for (const raw of rawAuthors) {
    const parts = raw.split(/,\s*|\s+and\s+/i);
    expanded.push(...parts);
  }

  const authors: { firstName: string; lastName: string }[] = [];
  const seen = new Set<string>();
  for (const name of expanded) {
    const parsed = splitAuthorName(name);
    if (parsed) {
      const key = `${parsed.firstName}|${parsed.lastName}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        authors.push(parsed);
      }
    }
  }

  return authors;
}

/**
 * Parse publishedAt from scrape metadata.
 */
export function parsePublishedAtFromMetadata(
  metadata: Record<string, unknown>
): string | null {
  const dateKeys = [
    "article:published_time",
    "og:article:published_time",
    "datePublished",
    "publishedTime",
    "date",
    "dc.date",
    "citation_publication_date",
    "sailthru.date",
  ];

  for (const key of dateKeys) {
    const val = metadata[key];
    if (typeof val === "string" && val.trim()) {
      const d = new Date(val.trim());
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }

  // Check JSON-LD
  const jsonLd = metadata["jsonLd"] || metadata["json-ld"] || metadata["jsonld"];
  if (jsonLd && typeof jsonLd === "object") {
    const ld = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
    for (const item of ld) {
      const ldObj = item as Record<string, unknown>;
      if (ldObj["@type"] === "Article" || ldObj["@type"] === "NewsArticle" || ldObj["@type"] === "BlogPosting") {
        const dp = ldObj["datePublished"];
        if (typeof dp === "string") {
          const d = new Date(dp);
          if (!isNaN(d.getTime())) return d.toISOString();
        }
      }
    }
  }

  return null;
}

/**
 * Extract article metadata (authors, publishedAt) from a URL.
 *
 * Uses a regular Firecrawl scrape (1 credit, no LLM) and parses
 * the HTML metadata instead of the expensive /v1/extract LLM API.
 */
export async function extractUrl(
  url: string,
  apiKey: string
): Promise<ExtractResult> {
  try {
    const scrapeResult = await scrapeUrl(url, apiKey, {
      formats: ["markdown"],
      onlyMainContent: false, // Need full page metadata
    });

    if (!scrapeResult.success) {
      return {
        success: false,
        error: scrapeResult.error || "Scrape failed",
      };
    }

    const metadata = (scrapeResult.metadata || {}) as Record<string, unknown>;
    const authors = parseAuthorsFromMetadata(metadata);
    const publishedAt = parsePublishedAtFromMetadata(metadata);

    return {
      success: true,
      authors,
      publishedAt,
    };
  } catch (error: any) {
    console.error("[scraping-service] Extract error:", error);
    return {
      success: false,
      error: error.message || "Extract request failed",
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
