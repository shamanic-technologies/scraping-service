import { Router } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { scrapeRequests, scrapeResults, scrapeCache } from "../db/schema.js";
import { scrapeUrl, normalizeUrl } from "../lib/firecrawl.js";
import { decryptByokKey, KeyServiceError } from "../lib/key-client.js";
import { createRun, updateRunStatus, addCosts } from "../lib/runs-client.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { ScrapeRequestSchema } from "../schemas.js";

const router = Router();

// Cache duration: 7 days
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * POST /scrape
 * Scrape a URL and extract company information
 */
router.post("/scrape", async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = ScrapeRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const {
      url,
      sourceService,
      sourceOrgId,
      sourceRefId,
      options,
      skipCache,
      brandId,
      campaignId,
      clerkUserId,
      parentRunId,
      workflowName,
    } = parsed.data;

    const normalized = normalizeUrl(url);

    // Check cache first (unless skipCache is true)
    if (!skipCache) {
      const cached = await db.query.scrapeCache.findFirst({
        where: and(
          eq(scrapeCache.normalizedUrl, normalized),
          eq(scrapeCache.isValid, true),
          gt(scrapeCache.expiresAt, new Date())
        ),
      });

      if (cached) {
        // Get full result
        const result = await db.query.scrapeResults.findFirst({
          where: eq(scrapeResults.id, cached.resultId),
        });

        if (result) {
          return res.json({
            cached: true,
            result: formatResult(result),
          });
        }
      }
    }

    // Decrypt org's Firecrawl key via key-service
    let firecrawlApiKey: string;
    try {
      const decrypted = await decryptByokKey("firecrawl", sourceOrgId, {
        method: "POST",
        path: "/scrape",
      });
      firecrawlApiKey = decrypted.key;
    } catch (err) {
      if (err instanceof KeyServiceError) {
        const status = err.statusCode === 404 ? 400 : 502;
        const message =
          err.statusCode === 404
            ? "Firecrawl API key not configured for this organization"
            : "Failed to retrieve Firecrawl API key";
        return res.status(status).json({ error: message });
      }
      throw err;
    }

    // Create run in RunsService
    let runId: string | undefined;
    try {
      const run = await createRun({
        clerkOrgId: sourceOrgId,
        taskName: "scrape",
        brandId,
        campaignId,
        clerkUserId,
        parentRunId,
        workflowName,
      });
      runId = run.id;
    } catch (err) {
      console.error("Failed to create run:", err);
    }

    // Create scrape request record
    const [request] = await db
      .insert(scrapeRequests)
      .values({
        sourceService: sourceService || req.sourceService || "unknown",
        sourceOrgId,
        sourceRefId,
        runId,
        url,
        options: options as any,
        status: "processing",
      })
      .returning();

    // Scrape the URL
    const scrapeResponse = await scrapeUrl(url, firecrawlApiKey, options || {});

    if (!scrapeResponse.success) {
      // Update request as failed
      await db
        .update(scrapeRequests)
        .set({
          status: "failed",
          errorMessage: scrapeResponse.error,
          completedAt: new Date(),
        })
        .where(eq(scrapeRequests.id, request.id));

      if (runId) {
        updateRunStatus(runId, "failed").catch((err) =>
          console.error("Failed to update run status:", err)
        );
      }

      return res.status(500).json({
        error: scrapeResponse.error || "Scrape failed",
        requestId: request.id,
        runId,
      });
    }

    // Extract company info from metadata and markdown
    const companyInfo = extractCompanyInfo(scrapeResponse);

    // Store result
    const expiresAt = new Date(Date.now() + CACHE_DURATION_MS);

    const [result] = await db
      .insert(scrapeResults)
      .values({
        requestId: request.id,
        url,
        normalizedUrl: normalized,
        companyName: companyInfo.companyName,
        description: companyInfo.description,
        industry: companyInfo.industry,
        website: url,
        rawMarkdown: scrapeResponse.markdown,
        rawMetadata: scrapeResponse.metadata as any,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: scrapeResults.normalizedUrl,
        set: {
          requestId: request.id,
          url,
          companyName: companyInfo.companyName,
          description: companyInfo.description,
          industry: companyInfo.industry,
          website: url,
          rawMarkdown: scrapeResponse.markdown,
          rawMetadata: scrapeResponse.metadata as any,
          expiresAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Update cache
    await db
      .insert(scrapeCache)
      .values({
        normalizedUrl: normalized,
        resultId: result.id,
        companyName: companyInfo.companyName,
        industry: companyInfo.industry,
        isValid: true,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: scrapeCache.normalizedUrl,
        set: {
          resultId: result.id,
          companyName: companyInfo.companyName,
          industry: companyInfo.industry,
          isValid: true,
          expiresAt,
          updatedAt: new Date(),
        },
      });

    // Update request as completed
    await db
      .update(scrapeRequests)
      .set({
        status: "completed",
        completedAt: new Date(),
      })
      .where(eq(scrapeRequests.id, request.id));

    // Report costs and complete run (fire-and-forget)
    if (runId) {
      Promise.all([
        addCosts(runId, [{ costName: "firecrawl-scrape-credit", quantity: 1 }]),
        updateRunStatus(runId, "completed"),
      ]).catch((err) => console.error("Failed to finalize run:", err));
    }

    res.json({
      cached: false,
      requestId: request.id,
      runId,
      result: formatResult(result),
    });
  } catch (error: any) {
    console.error("Scrape error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/**
 * GET /scrape/:id
 * Get a scrape result by ID
 */
router.get("/scrape/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query.scrapeResults.findFirst({
      where: eq(scrapeResults.id, id),
    });

    if (!result) {
      return res.status(404).json({ error: "Result not found" });
    }

    res.json({ result: formatResult(result) });
  } catch (error: any) {
    console.error("Get result error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/**
 * GET /scrape/by-url
 * Get cached result by URL
 */
router.get("/scrape/by-url", async (req, res) => {
  try {
    const url = req.query.url as string;

    if (!url) {
      return res.status(400).json({ error: "url query param is required" });
    }

    const normalized = normalizeUrl(url);

    const cached = await db.query.scrapeCache.findFirst({
      where: and(
        eq(scrapeCache.normalizedUrl, normalized),
        eq(scrapeCache.isValid, true)
      ),
    });

    if (!cached) {
      return res.status(404).json({ error: "No cached result found" });
    }

    const result = await db.query.scrapeResults.findFirst({
      where: eq(scrapeResults.id, cached.resultId),
    });

    if (!result) {
      return res.status(404).json({ error: "Result not found" });
    }

    res.json({
      cached: true,
      expired: cached.expiresAt < new Date(),
      result: formatResult(result),
    });
  } catch (error: any) {
    console.error("Get by URL error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/**
 * Extract company info from scrape response
 */
function extractCompanyInfo(response: { markdown?: string; metadata?: any }) {
  const metadata = response.metadata || {};

  return {
    companyName: metadata.ogTitle || metadata.title || null,
    description: metadata.ogDescription || metadata.description || null,
    industry: null, // Would need AI extraction for this
  };
}

/**
 * Format result for API response
 */
function formatResult(result: any) {
  return {
    id: result.id,
    url: result.url,
    companyName: result.companyName,
    description: result.description,
    industry: result.industry,
    employeeCount: result.employeeCount,
    foundedYear: result.foundedYear,
    headquarters: result.headquarters,
    website: result.website,
    email: result.email,
    phone: result.phone,
    linkedinUrl: result.linkedinUrl,
    twitterUrl: result.twitterUrl,
    products: result.products,
    services: result.services,
    rawMarkdown: result.rawMarkdown,
    createdAt: result.createdAt,
  };
}

export default router;
