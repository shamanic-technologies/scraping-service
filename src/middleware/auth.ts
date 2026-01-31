import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  sourceService?: string;
}

/**
 * Service-to-service authentication via API key
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

  // Extract source service from header if provided
  req.sourceService = req.headers["x-source-service"] as string;

  next();
}
