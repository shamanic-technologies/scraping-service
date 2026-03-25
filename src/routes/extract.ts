import { Router } from "express";
import { extractUrl } from "../lib/firecrawl.js";
import { resolveKey, KeyServiceError } from "../lib/key-client.js";
import { createRun, updateRunStatus, addCosts } from "../lib/runs-client.js";
import { authorizeCredits } from "../lib/billing-client.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { ExtractRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /extract
 * Extract article metadata (authors, publishedAt) from one or more URLs
 * using Firecrawl's LLM Extract.
 */
router.post("/extract", async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = ExtractRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const { urls, brandId, campaignId, workflowName, featureSlug } =
      parsed.data;

    const orgId = req.orgId!;
    const userId = req.userId!;
    const parentRunId = req.runId;

    const effectiveCampaignId = req.campaignId || campaignId;
    const effectiveBrandId = req.brandId || brandId;
    const effectiveWorkflowName = req.workflowName || workflowName;
    const effectiveFeatureSlug = req.featureSlug || featureSlug;

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

    // Authorize credits (platform keys only) — 1 extract credit per URL
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
              costName: "firecrawl-extract-credit",
              quantity: urls.length,
            },
          ],
          "firecrawl-extract-credit",
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
      console.error("Failed to create run:", err);
    }

    // Extract from all URLs concurrently
    const results = await Promise.all(
      urls.map(async (url) => {
        const result = await extractUrl(url, firecrawlApiKey);
        if (!result.success) {
          return {
            url,
            success: false as const,
            error: result.error || "Extract failed",
          };
        }
        return {
          url,
          success: true as const,
          authors: result.authors || [],
          publishedAt: result.publishedAt || null,
          rawMarkdown: result.markdown || null,
        };
      })
    );

    const successCount = results.filter((r) => r.success).length;
    const allFailed = successCount === 0;

    // Report costs and complete run
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
      Promise.all([
        addCosts(
          runId,
          [
            {
              costName: "firecrawl-extract-credit",
              quantity: urls.length,
              costSource: keySource,
            },
          ],
          runIdentity
        ),
        updateRunStatus(runId, allFailed ? "failed" : "completed", runIdentity),
      ]).catch((err) => console.error("Failed to finalize run:", err));
    }

    res.json({
      results,
      runId,
    });
  } catch (error: any) {
    console.error("Extract error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
