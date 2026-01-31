import { Router } from "express";
import { mapUrl, MapOptions } from "../lib/firecrawl.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

interface MapRequestBody {
  url: string;
  search?: string;
  limit?: number;
  ignoreSitemap?: boolean;
  sitemapOnly?: boolean;
  includeSubdomains?: boolean;
}

/**
 * POST /map
 * Discover all URLs on a website using Firecrawl's map endpoint
 */
router.post("/map", async (req: AuthenticatedRequest, res) => {
  try {
    const {
      url,
      search,
      limit = 100,
      ignoreSitemap,
      sitemapOnly,
      includeSubdomains,
    } = req.body as MapRequestBody;

    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }

    const options: MapOptions = {
      search,
      limit: Math.min(limit, 500), // Cap at 500
      ignoreSitemap,
      sitemapOnly,
      includeSubdomains,
    };

    const result = await mapUrl(url, options);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || "Failed to map URL",
      });
    }

    res.json({
      success: true,
      urls: result.urls,
      count: result.urls?.length || 0,
    });
  } catch (error: any) {
    console.error("Map error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
