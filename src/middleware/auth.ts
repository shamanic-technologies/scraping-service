import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  sourceService?: string;
  orgId?: string;
  userId?: string;
  runId?: string;
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

  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-API-Key header" });
  }

  const validKey = process.env.SCRAPING_SERVICE_API_KEY;

  if (!validKey || apiKey !== validKey) {
    return res.status(401).json({ error: "Invalid API key" });
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

  next();
}
