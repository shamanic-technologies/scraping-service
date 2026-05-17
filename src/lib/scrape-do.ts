import { ScrapeOptions, ScrapeResponse } from "./firecrawl.js";

const SCRAPE_DO_API_URL = "https://api.scrape.do";
const DEFAULT_TIMEOUT_MS = 60000;
const RETRY_TIMEOUT_MS = 120000;
const FETCH_ABORT_TIMEOUT_MS = 150000;

export interface ScrapeDoOverrides {
  render?: boolean;
  super?: boolean;
  waitUntil?: string;
  customWait?: number;
}

/**
 * Scrape a URL using Scrape.do.
 * On a 408 timeout, automatically retries once with a longer timeout.
 */
export async function scrapeUrlWithScrapeDo(
  url: string,
  apiKey: string,
  options: ScrapeOptions = {},
  overrides: ScrapeDoOverrides = {}
): Promise<ScrapeResponse> {
  const baseTimeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  const attempt = async (timeout: number): Promise<ScrapeResponse> => {
    const params = new URLSearchParams({
      token: apiKey,
      url,
      output: "markdown",
    });

    if (options.waitFor) {
      params.set("render", "true");
      params.set("wait", String(options.waitFor));
    }

    // Escalation overrides take precedence
    if (overrides.render) {
      params.set("render", "true");
    }
    if (overrides.super) {
      params.set("super", "true");
    }
    if (overrides.waitUntil) {
      params.set("waitUntil", overrides.waitUntil);
    }
    if (overrides.customWait) {
      params.set("customWait", String(overrides.customWait));
    }

    params.set("timeout", String(timeout));

    const response = await fetch(`${SCRAPE_DO_API_URL}/?${params.toString()}`, {
      signal: AbortSignal.timeout(FETCH_ABORT_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 408) {
        const err = new Error("Scrape.do request timed out") as Error & { statusCode: number };
        err.statusCode = 408;
        throw err;
      }
      const errBody = await response.text();
      return {
        success: false,
        error: `Scrape.do failed (${response.status}): ${errBody}`,
      };
    }

    const markdown = await response.text();

    const requestCostHeader = response.headers.get("scrape.do-request-cost");
    const parsedCost = requestCostHeader ? Number(requestCostHeader) : NaN;
    const requestCost = Number.isFinite(parsedCost) ? parsedCost : undefined;

    return {
      success: true,
      markdown,
      requestCost,
    };
  };

  try {
    return await attempt(baseTimeout);
  } catch (error: any) {
    if (error.statusCode === 408) {
      console.warn(
        `[scraping-service] Scrape.do timeout scraping ${url} (${baseTimeout}ms), retrying with ${RETRY_TIMEOUT_MS}ms`
      );
      try {
        return await attempt(RETRY_TIMEOUT_MS);
      } catch (retryError: any) {
        console.error("[scraping-service] Scrape.do retry also failed:", retryError);
        return {
          success: false,
          error: retryError.message || "Scrape.do request timed out after retry",
        };
      }
    }
    console.error("[scraping-service] Scrape.do error:", error);
    return {
      success: false,
      error: error.message || "Scrape.do request failed",
    };
  }
}
