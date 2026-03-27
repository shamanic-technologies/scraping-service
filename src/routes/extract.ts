import { Router } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { extractCache } from "../db/schema.js";
import { extractUrl, normalizeUrl } from "../lib/firecrawl.js";
import { resolveKey, KeyServiceError } from "../lib/key-client.js";
import { createRun, updateRunStatus, addCosts } from "../lib/runs-client.js";
import { authorizeCredits } from "../lib/billing-client.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { ExtractRequestSchema } from "../schemas.js";

const router = Router();

// Default cache duration: 6 months (180 days)
const DEFAULT_CACHE_DURATION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * POST /extract
 * Extract article metadata (authors, publishedAt) from one or more URLs
 * using Firecrawl's LLM Extract.
 * Results are cached for 7 days per normalized URL.
 */
router.post("/extract", async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = ExtractRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const { urls, skipCache, cacheTtlDays, brandId, campaignId, workflowName, featureSlug } =
      parsed.data;

    const orgId = req.orgId!;
    const userId = req.userId!;
    const parentRunId = req.runId;

    const effectiveCampaignId = req.campaignId || campaignId;
    const effectiveBrandId = req.brandId || brandId;
    const effectiveWorkflowName = req.workflowName || workflowName;
    const effectiveFeatureSlug = req.featureSlug || featureSlug;

    // Check cache for each URL
    const normalizedUrls = urls.map((url) => ({
      url,
      normalized: normalizeUrl(url),
    }));

    const cachedResults: Map<
      string,
      { authors: { firstName: string; lastName: string }[]; publishedAt: string | null }
    > = new Map();
    const uncachedUrls: { url: string; normalized: string }[] = [];

    if (!skipCache) {
      await Promise.all(
        normalizedUrls.map(async ({ url, normalized }) => {
          const cached = await db.query.extractCache.findFirst({
            where: and(
              eq(extractCache.normalizedUrl, normalized),
              eq(extractCache.isValid, true),
              gt(extractCache.expiresAt, new Date())
            ),
          });

          if (cached) {
            cachedResults.set(url, {
              authors: (cached.authors as { firstName: string; lastName: string }[]) || [],
              publishedAt: cached.publishedAt || null,
            });
          } else {
            uncachedUrls.push({ url, normalized });
          }
        })
      );
    } else {
      uncachedUrls.push(...normalizedUrls);
    }

    // If everything is cached, return immediately (no key resolution, no billing, no run)
    if (uncachedUrls.length === 0) {
      const results = urls.map((url) => {
        const cached = cachedResults.get(url)!;
        return {
          url,
          success: true as const,
          authors: cached.authors,
          publishedAt: cached.publishedAt,
          cached: true,
        };
      });

      return res.json({
        results,
        tokensUsed: 0,
        cached: true,
      });
    }

    // Resolve Firecrawl key
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
        caller: { method: "POST", path: "/extract" },
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

    // Authorize credits (platform keys only) — 1 scrape credit per uncached URL
    if (keySource === "platform") {
      try {
        const billingIdentity = {
          orgId,
          userId,
          runId: parentRunId,
          campaignId: effectiveCampaignId,
          brandId: effectiveBrandId,
          workflowName: effectiveWorkflowName,
          featureSlug: effectiveFeatureSlug,
        };
        const auth = await authorizeCredits(
          [
            {
              costName: "firecrawl-scrape-credit",
              quantity: uncachedUrls.length,
            },
          ],
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
        console.error("[scraping-service] Billing authorization failed:", err);
        return res
          .status(502)
          .json({ error: "Billing authorization unavailable" });
      }
    }

    // Create run
    let runId: string | undefined;
    try {
      const run = await createRun(
        {
          taskName: "extract",
          brandId: effectiveBrandId,
          campaignId: effectiveCampaignId,
          workflowName: effectiveWorkflowName,
          featureSlug: effectiveFeatureSlug,
        },
        {
          orgId,
          userId,
          runId: parentRunId,
          campaignId: effectiveCampaignId,
          brandId: effectiveBrandId,
          workflowName: effectiveWorkflowName,
          featureSlug: effectiveFeatureSlug,
        }
      );
      runId = run.id;
    } catch (err) {
      console.error("[scraping-service] Failed to create run:", err);
    }

    // Extract only uncached URLs
    const freshResults = await Promise.all(
      uncachedUrls.map(async ({ url, normalized }) => {
        const result = await extractUrl(url, firecrawlApiKey);

        // Write to cache on success
        if (result.success) {
          const cacheDurationMs = cacheTtlDays
            ? cacheTtlDays * 24 * 60 * 60 * 1000
            : DEFAULT_CACHE_DURATION_MS;
          const expiresAt = new Date(Date.now() + cacheDurationMs);
          try {
            await db
              .insert(extractCache)
              .values({
                normalizedUrl: normalized,
                authors: (result.authors || []) as any,
                publishedAt: result.publishedAt || null,
                isValid: true,
                expiresAt,
              })
              .onConflictDoUpdate({
                target: extractCache.normalizedUrl,
                set: {
                  authors: (result.authors || []) as any,
                  publishedAt: result.publishedAt || null,
                  isValid: true,
                  expiresAt,
                  updatedAt: new Date(),
                },
              });
          } catch (cacheErr) {
            console.error("[scraping-service] Failed to write extract cache:", cacheErr);
          }
        }

        return { url, result };
      })
    );

    // Merge cached + fresh results, preserving original URL order
    const freshMap = new Map(freshResults.map(({ url, result }) => [url, result]));

    const results = urls.map((url) => {
      const cached = cachedResults.get(url);
      if (cached) {
        return {
          url,
          success: true as const,
          authors: cached.authors,
          publishedAt: cached.publishedAt,
          cached: true,
        };
      }

      const fresh = freshMap.get(url)!;
      if (!fresh.success) {
        return {
          url,
          success: false as const,
          error: fresh.error || "Extract failed",
        };
      }
      return {
        url,
        success: true as const,
        authors: fresh.authors || [],
        publishedAt: fresh.publishedAt || null,
      };
    });

    const successCount = results.filter((r) => r.success).length;
    const freshSuccessCount = freshResults.filter(({ result }) => result.success).length;
    const allFailed = successCount === 0;

    // Report costs (1 scrape credit per successful fresh extraction) and complete run
    if (runId) {
      const runIdentity = {
        orgId,
        userId,
        runId,
        campaignId: effectiveCampaignId,
        brandId: effectiveBrandId,
        workflowName: effectiveWorkflowName,
        featureSlug: effectiveFeatureSlug,
      };
      const costItems = freshSuccessCount > 0
        ? [{ costName: "firecrawl-scrape-credit", quantity: freshSuccessCount, costSource: keySource }]
        : [];
      Promise.all([
        ...(costItems.length > 0
          ? [addCosts(runId, costItems, runIdentity)]
          : []),
        updateRunStatus(runId, allFailed ? "failed" : "completed", runIdentity),
      ]).catch((err) => console.error("[scraping-service] Failed to finalize run:", err));
    }

    res.json({
      results,
      tokensUsed: 0,
      runId,
    });
  } catch (error: any) {
    console.error("[scraping-service] Extract error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
