import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  sourceService?: string;
  orgId?: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
}

/**
 * Service-to-service authentication via API key + identity headers
 */
export function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  // Skip auth for health check
  if (req.path === "/health" || req.path === "/") {
    return next();
  }

  // Internal routes: API key only, no org/user/run headers required
  const isInternalRoute = req.path.startsWith("/internal/");

  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-API-Key header" });
  }

  const validKey = process.env.SCRAPING_SERVICE_API_KEY;

  if (!validKey || apiKey !== validKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Internal routes skip identity header requirements
  if (isInternalRoute) {
    return next();
  }

  // Extract and require identity headers
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;

  if (!orgId) {
    return res.status(400).json({ error: "Missing X-Org-Id header" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Missing X-User-Id header" });
  }

  const runId = req.headers["x-run-id"] as string;

  if (!runId) {
    return res.status(400).json({ error: "Missing X-Run-Id header" });
  }

  req.orgId = orgId;
  req.userId = userId;
  req.runId = runId;

  // Extract source service from header if provided
  req.sourceService = req.headers["x-source-service"] as string;

  // Extract optional tracking headers (injected by workflow-service)
  req.campaignId = req.headers["x-campaign-id"] as string | undefined;
  // x-brand-id is CSV (e.g. "uuid1,uuid2,uuid3")
  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  req.brandIds = rawBrandId
    ? String(rawBrandId).split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  req.workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  req.featureSlug = req.headers["x-feature-slug"] as string | undefined;

  next();
}
