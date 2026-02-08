import { Router } from "express";
import { mapUrl, MapOptions } from "../lib/firecrawl.js";
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

    const { url, search, limit, ignoreSitemap, sitemapOnly, includeSubdomains } =
      parsed.data;

    const options: MapOptions = {
      search,
      limit, // Already capped at 500 by schema max
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
