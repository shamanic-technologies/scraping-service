import { Router } from "express";
import { mapUrl, MapOptions } from "../lib/firecrawl.js";
import { resolveKey, KeyServiceError } from "../lib/key-client.js";
import { createRun, updateRunStatus, addCosts } from "../lib/runs-client.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { MapRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /map
 * Discover all URLs on a website using Firecrawl's map endpoint
 */
router.post("/map", async (req: AuthenticatedRequest, res) => {
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
      brandId,
      campaignId,
      workflowName,
    } = parsed.data;

    const orgId = (req as AuthenticatedRequest).orgId!;
    const userId = (req as AuthenticatedRequest).userId!;
    const parentRunId = (req as AuthenticatedRequest).runId;

    // Headers take precedence over body fields for tracking
    const effectiveCampaignId = (req as AuthenticatedRequest).campaignId || campaignId;
    const effectiveBrandId = (req as AuthenticatedRequest).brandId || brandId;
    const effectiveWorkflowName = (req as AuthenticatedRequest).workflowName || workflowName;

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

    // Create run in RunsService
    // x-run-id = parentRunId so runs-service sets it as the parent
    let runId: string | undefined;
    try {
      const run = await createRun(
        { taskName: "map", brandId: effectiveBrandId, campaignId: effectiveCampaignId, workflowName: effectiveWorkflowName },
        { orgId, userId, runId: parentRunId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName }
      );
      runId = run.id;
    } catch (err) {
      console.error("Failed to create run:", err);
    }

    const options: MapOptions = {
      search,
      limit, // Already capped at 500 by schema max
      ignoreSitemap,
      sitemapOnly,
      includeSubdomains,
    };

    const result = await mapUrl(url, firecrawlApiKey, options);

    if (!result.success) {
      if (runId) {
        updateRunStatus(runId, "failed", { orgId, userId, runId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName }).catch((err) =>
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
      const runIdentity = { orgId, userId, runId, campaignId: effectiveCampaignId, brandId: effectiveBrandId, workflowName: effectiveWorkflowName };
      Promise.all([
        addCosts(runId, [{ costName: "firecrawl-map-credit", quantity: 1, costSource: keySource }], runIdentity),
        updateRunStatus(runId, "completed", runIdentity),
      ]).catch((err) => console.error("Failed to finalize run:", err));
    }

    res.json({
      success: true,
      urls: result.urls,
      count: result.urls?.length || 0,
      runId,
    });
  } catch (error: any) {
    console.error("Map error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
