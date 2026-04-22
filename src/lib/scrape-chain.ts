import { ScrapeOptions, ScrapeResponse, scrapeUrl } from "./firecrawl.js";
import { scrapeUrlWithScrapeDo, ScrapeDoOverrides } from "./scrape-do.js";

interface EscalationLevel {
  name: string;
  costName: string;
  provider: "scrape-do" | "firecrawl";
  scrapeDoOverrides?: ScrapeDoOverrides;
}

const ESCALATION_LEVELS: EscalationLevel[] = [
  {
    name: "scrape-do-basic",
    costName: "scrape-do-credit",
    provider: "scrape-do",
  },
  {
    name: "scrape-do-render",
    costName: "scrape-do-credit",
    provider: "scrape-do",
    scrapeDoOverrides: { render: true, waitUntil: "networkidle0", customWait: 3000 },
  },
  {
    name: "scrape-do-render-super",
    costName: "scrape-do-credit",
    provider: "scrape-do",
    scrapeDoOverrides: { render: true, super: true, waitUntil: "networkidle0", customWait: 3000 },
  },
  {
    name: "firecrawl-fallback",
    costName: "firecrawl-scrape-credit",
    provider: "firecrawl",
  },
];

export interface ScrapeChainParams {
  url: string;
  scrapeDoApiKey: string;
  options: ScrapeOptions;
  resolveFirecrawlKey: () => Promise<{ key: string; keySource: "org" | "platform" }>;
}

export interface ScrapeChainResult {
  response: ScrapeResponse;
  costName: string;
  levelName: string;
  provider: "scrape-do" | "firecrawl";
  keySource: "org" | "platform";
  requestCost?: number;
}

/**
 * Scrape a URL with automatic escalation through increasingly capable strategies.
 *
 * Level 1: Basic Scrape.do (no rendering)
 * Level 2: Scrape.do with JS rendering
 * Level 3: Scrape.do with JS rendering + residential proxy
 * Level 4: Firecrawl fallback
 *
 * Failed Scrape.do requests are free — only the successful attempt is billed.
 */
export async function scrapeWithEscalation(
  params: ScrapeChainParams,
  scrapeDoKeySource: "org" | "platform"
): Promise<ScrapeChainResult> {
  let lastError: string | undefined;

  for (const level of ESCALATION_LEVELS) {
    if (level.provider === "scrape-do") {
      const response = await scrapeUrlWithScrapeDo(
        params.url,
        params.scrapeDoApiKey,
        params.options,
        level.scrapeDoOverrides
      );

      if (response.success) {
        console.log(`[scraping-service] Scrape succeeded at level ${level.name} for ${params.url}`);
        return {
          response,
          costName: level.costName,
          levelName: level.name,
          provider: "scrape-do",
          keySource: scrapeDoKeySource,
          requestCost: response.requestCost,
        };
      }

      console.log(`[scraping-service] Level ${level.name} failed for ${params.url}, escalating`);
      lastError = response.error;
      continue;
    }

    // Firecrawl fallback
    let firecrawlKey: string;
    let firecrawlKeySource: "org" | "platform";
    try {
      const resolved = await params.resolveFirecrawlKey();
      firecrawlKey = resolved.key;
      firecrawlKeySource = resolved.keySource;
    } catch (err) {
      console.log(`[scraping-service] Firecrawl key resolution failed, skipping fallback: ${err}`);
      continue;
    }

    const response = await scrapeUrl(params.url, firecrawlKey, params.options);

    if (response.success) {
      console.log(`[scraping-service] Scrape succeeded at level ${level.name} for ${params.url}`);
      return {
        response,
        costName: level.costName,
        levelName: level.name,
        provider: "firecrawl",
        keySource: firecrawlKeySource,
      };
    }

    console.log(`[scraping-service] Level ${level.name} failed for ${params.url}, no more levels`);
    lastError = response.error;
  }

  console.warn(`[scraping-service] All escalation levels failed for ${params.url}: ${lastError}`);
  return {
    response: { success: false, error: lastError || "All escalation levels failed" },
    costName: ESCALATION_LEVELS[ESCALATION_LEVELS.length - 1].costName,
    levelName: "all-failed",
    provider: "scrape-do",
    keySource: scrapeDoKeySource,
  };
}
