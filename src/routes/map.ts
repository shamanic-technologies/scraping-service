import { Router } from "express";
import { mapUrl, homepageLinks, MapOptions, MapResponse } from "../lib/firecrawl.js";
import { resolveKey, KeyServiceError } from "../lib/key-client.js";
import { createRun, updateRunStatus, addCosts } from "../lib/runs-client.js";
import { authorizeCredits } from "../lib/billing-client.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { MapRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /map
 * Discover URLs on a website using Firecrawl's map endpoint, bounded in time.
 * When the map hits its ceiling (big sites Firecrawl has not indexed yet), the
 * route answers with the homepage's own links instead (source: "homepage-links").
 */
router.post("/map", async (req: AuthenticatedRequest, res) => {
  let runId: string | undefined;
  try {
    const parsed = MapRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const {
      url,
      search,
      limit,
      ignoreSitemap,
      sitemapOnly,
      includeSubdomains,
      brandIds,
      campaignId,
      workflowSlug,
      featureSlug,
      audienceId,
    } = parsed.data;

    const orgId = (req as AuthenticatedRequest).orgId!;
    const userId = (req as AuthenticatedRequest).userId!;
    const parentRunId = (req as AuthenticatedRequest).runId;

    // Headers take precedence over body fields for tracking
    const effectiveCampaignId = (req as AuthenticatedRequest).campaignId || campaignId;
    const effectiveBrandIds = (req as AuthenticatedRequest).brandIds || brandIds;
    const effectiveWorkflowSlug = (req as AuthenticatedRequest).workflowSlug || workflowSlug;
    const effectiveFeatureSlug = (req as AuthenticatedRequest).featureSlug || featureSlug;
    const effectiveAudienceId = (req as AuthenticatedRequest).audienceId || audienceId;

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
        brandIds: effectiveBrandIds,
        workflowSlug: effectiveWorkflowSlug,
        featureSlug: effectiveFeatureSlug,
        audienceId: effectiveAudienceId,
        caller: { method: "POST", path: "/map" },
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
        const billingIdentity = { orgId, userId, runId: parentRunId, campaignId: effectiveCampaignId, brandIds: effectiveBrandIds, workflowSlug: effectiveWorkflowSlug, featureSlug: effectiveFeatureSlug, audienceId: effectiveAudienceId};
        const auth = await authorizeCredits(
          [{ costName: "firecrawl-map-credit", quantity: 1 }],
          "firecrawl-map-credit",
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
    try {
      const run = await createRun(
        { taskName: "map", brandIds: effectiveBrandIds, campaignId: effectiveCampaignId, workflowSlug: effectiveWorkflowSlug, featureSlug: effectiveFeatureSlug, audienceId: effectiveAudienceId},
        { orgId, userId, runId: parentRunId, campaignId: effectiveCampaignId, brandIds: effectiveBrandIds, workflowSlug: effectiveWorkflowSlug, featureSlug: effectiveFeatureSlug, audienceId: effectiveAudienceId}
      );
      runId = run.id;
    } catch (err) {
      console.error("Failed to create run:", err);
    }

    const options: MapOptions = {
      search,
      limit,
      ignoreSitemap,
      sitemapOnly,
      includeSubdomains,
    };

    const runIdentity = { orgId, userId, runId: runId ?? parentRunId, campaignId: effectiveCampaignId, brandIds: effectiveBrandIds, workflowSlug: effectiveWorkflowSlug, featureSlug: effectiveFeatureSlug, audienceId: effectiveAudienceId};

    let result: MapResponse = await mapUrl(url, firecrawlApiKey, options);
    let source: "map" | "homepage-links" = "map";
    // What Firecrawl actually charged: a map stopped at the ceiling costs nothing
    // (measured 2026-10-06), the fallback homepage scrape costs one scrape credit.
    let costName: "firecrawl-map-credit" | "firecrawl-scrape-credit" = "firecrawl-map-credit";

    if (!result.success && result.timedOut) {
      if (keySource === "platform") {
        try {
          const auth = await authorizeCredits(
            [{ costName: "firecrawl-scrape-credit", quantity: 1 }],
            "firecrawl-scrape-credit",
            { ...runIdentity, runId: parentRunId }
          );
          if (!auth.sufficient) {
            if (runId) {
              updateRunStatus(runId, "failed", runIdentity).catch((err) =>
                console.error("Failed to update run status:", err)
              );
            }
            return res.status(402).json({
              error: "Insufficient credits",
              balance_cents: auth.balance_cents,
              required_cents: auth.required_cents,
            });
          }
        } catch (err) {
          console.error("Billing authorization failed:", err);
          if (runId) {
            updateRunStatus(runId, "failed", runIdentity).catch((e) =>
              console.error("Failed to update run status:", e)
            );
          }
          return res.status(502).json({ error: "Billing authorization unavailable" });
        }
      }

      result = await homepageLinks(url, firecrawlApiKey, { includeSubdomains, limit });
      source = "homepage-links";
      costName = "firecrawl-scrape-credit";
    }

    if (!result.success) {
      if (runId) {
        updateRunStatus(runId, "failed", runIdentity).catch((err) =>
          console.error("Failed to update run status:", err)
        );
      }

      return res.status(500).json({
        success: false,
        error: result.error || "Failed to map URL",
        runId,
      });
    }

    // Report costs and complete run (fire-and-forget)
    if (runId) {
      Promise.all([
        addCosts(runId, [{ costName, quantity: 1, costSource: keySource }], runIdentity),
        updateRunStatus(runId, "completed", runIdentity),
      ]).catch((err) => console.error("Failed to finalize run:", err));
    }

    res.json({
      success: true,
      urls: result.urls,
      count: result.urls?.length || 0,
      source,
      runId,
    });
  } catch (error: any) {
    console.error("[scraping-service] Map error:", error);

    if (runId) {
      const orgId = (req as AuthenticatedRequest).orgId!;
      const userId = (req as AuthenticatedRequest).userId!;
      updateRunStatus(runId, "failed", { orgId, userId, runId }).catch((err) =>
        console.error("[scraping-service] Failed to close run in outer catch:", err)
      );
    }

    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
