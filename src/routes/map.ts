import { Router } from "express";
import { mapUrl, MapOptions } from "../lib/firecrawl.js";
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
      sourceOrgId,
      brandId,
      campaignId,
      clerkUserId,
      parentRunId,
      workflowName,
    } = parsed.data;

    // Create run in RunsService if sourceOrgId is provided
    let runId: string | undefined;
    if (sourceOrgId) {
      try {
        const run = await createRun({
          clerkOrgId: sourceOrgId,
          taskName: "map",
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
    }

    const options: MapOptions = {
      search,
      limit, // Already capped at 500 by schema max
      ignoreSitemap,
      sitemapOnly,
      includeSubdomains,
    };

    const result = await mapUrl(url, options);

    if (!result.success) {
      if (runId) {
        updateRunStatus(runId, "failed").catch((err) =>
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
        addCosts(runId, [{ costName: "firecrawl-map-credit", quantity: 1 }]),
        updateRunStatus(runId, "completed"),
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
