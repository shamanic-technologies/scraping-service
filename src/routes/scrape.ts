import { Router } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { scrapeRequests, scrapeResults, scrapeCache } from "../db/schema.js";
import { scrapeUrl, normalizeUrl } from "../lib/firecrawl.js";
import { resolveKey, KeyServiceError } from "../lib/key-client.js";
import { createRun, updateRunStatus, addCosts } from "../lib/runs-client.js";
import { authorizeCredits } from "../lib/billing-client.js";
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
      sourceRefId,
      options,
      skipCache,
      brandId,
      campaignId,
      workflowName,
      featureSlug,
    } = parsed.data;

    const orgId = (req as AuthenticatedRequest).orgId!;
    const userId = (req as AuthenticatedRequest).userId!;
    const parentRunId = (req as AuthenticatedRequest).runId;

    // Headers take precedence over body fields for tracking
    const effectiveCampaignId = (req as AuthenticatedRequest).campaignId || campaignId;
    const effectiveBrandId = (req as AuthenticatedRequest).brandId || brandId;
    const effectiveWorkflowName = (req as AuthenticatedRequest).workflowName || workflowName;
    const effectiveFeatureSlug = (req as AuthenticatedRequest).featureSlug || featureSlug;

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

    // Resolve Firecrawl key via key-service (auto-resolves org/platform source)
    let firecrawlApiKey: string;
    let keySource: "org" | "platform";
    try {
      const decrypted = await resolveKey({
        provider: "firecrawl",
        orgId,
        userId,
        runId: parentRunId,
        campaignId: effectiveCampaignId,
        brandId: effectiveBrandId,
        workflowName: effectiveWorkflowName,
        featureSlug: effectiveFeatureSlug,
        caller: { method: "POST", path: "/scrape" },
      });
      firecrawlApiKey = decrypted.key;
      keySource = decrypted.keySource;
    } catch (err) {
      if (err instanceof KeyServiceError) {
        const status = err.statusCode === 404 ? 400 : 502;
        const message =
          err.statusCode === 404
            ? "Firecrawl API key not configured"
            : "Failed to retrieve Firecrawl API key";
        return res.status(status).json({ error: message });
      }
      throw err;
    }

    // Authorize credits with billing-service (platform keys only)
    if (keySource === "platform") {
      try {
        const billingIdentity = { orgId, userId, runId: parentRunId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName, featureSlug: effectiveFeatureSlug };
        const auth = await authorizeCredits(
          [{ costName: "firecrawl-scrape-credit", quantity: 1 }],
          "firecrawl-scrape-credit",
          billingIdentity
        );
        if (!auth.sufficient) {
          return res.status(402).json({
            error: "Insufficient credits",
            balance_cents: auth.balance_cents,
            required_cents: auth.required_cents,
          });
        }
      } catch (err) {
        console.error("Billing authorization failed:", err);
        return res.status(502).json({ error: "Billing authorization unavailable" });
      }
    }

    // Create run in RunsService
    // x-run-id = parentRunId so runs-service sets it as the parent
    let runId: string | undefined;
    try {
      const run = await createRun(
        { taskName: "scrape", brandId: effectiveBrandId, campaignId: effectiveCampaignId, workflowName: effectiveWorkflowName, featureSlug: effectiveFeatureSlug },
        { orgId, userId, runId: parentRunId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName, featureSlug: effectiveFeatureSlug }
      );
      runId = run.id;
    } catch (err) {
      console.error("Failed to create run:", err);
    }

    // Create scrape request record
    const [request] = await db
      .insert(scrapeRequests)
      .values({
        sourceService: sourceService || req.sourceService || "unknown",
        orgId,
        sourceRefId,
        runId,
        campaignId: effectiveCampaignId,
        brandId: effectiveBrandId,
        workflowName: effectiveWorkflowName,
        featureSlug: effectiveFeatureSlug,
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
        updateRunStatus(runId, "failed", { orgId, userId, runId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName, featureSlug: effectiveFeatureSlug }).catch((err) =>
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
      const runIdentity = { orgId, userId, runId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName, featureSlug: effectiveFeatureSlug };
      Promise.all([
        addCosts(runId, [{ costName: "firecrawl-scrape-credit", quantity: 1, costSource: keySource }], runIdentity),
        updateRunStatus(runId, "completed", runIdentity),
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
 * GET /scrape/by-url
 * Get cached result by URL
 * NOTE: Must be registered BEFORE /scrape/:id to avoid "by-url" matching as a UUID param
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
