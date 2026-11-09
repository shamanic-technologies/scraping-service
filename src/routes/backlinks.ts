import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BacklinkCheckRequestSchema, LinkGapRequestSchema } from "../schemas.js";
import { BacklinkError, type MeterIdentity } from "../lib/treg-meter.js";
import { runBacklinkCheck, runLinkGap, wireLink, type Deps } from "../lib/backlinks.js";
import { brandSiteDomain, siteDomainOf } from "../lib/brand-client.js";
import { drizzleBacklinkStore } from "../lib/backlink-store.js";
import { errorMessage } from "../lib/db-error.js";

export function buildBacklinkRouter(deps: Deps): Router {
  const router = Router();

  function identityOf(req: AuthenticatedRequest): { identity: MeterIdentity; brandId: string } {
    const brands = req.brandIds ?? [];
    if (brands.length !== 1) {
      throw new BacklinkError("brand_required", 400, "x-brand-id must name exactly one brand (the brand whose site is checked)");
    }
    return {
      brandId: brands[0],
      identity: {
        orgId: req.orgId!,
        userId: req.userId!,
        runId: req.runId!,
        brandIds: brands,
        campaignId: req.campaignId,
        workflowSlug: req.workflowSlug,
        featureSlug: req.featureSlug,
      },
    };
  }

  function fail(res: Response, err: unknown, what: string) {
    if (err instanceof BacklinkError) {
      if (err.httpStatus >= 500) console.error(`[scraping-service] ${what} ${err.code}: ${err.message}`);
      return res.status(err.httpStatus).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    console.error(`[scraping-service] ${what} failed:`, err);
    return res.status(500).json({ error: "internal_error", message: errorMessage(err, "Internal server error") });
  }

  router.post("/orgs/backlinks/checks", async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = BacklinkCheckRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      const { identity, brandId } = identityOf(req);
      const answer = await runBacklinkCheck(
        {
          identity,
          brandId,
          outcomeKey: parsed.data.outcomeKey,
          idempotencyKey: parsed.data.idempotencyKey,
          windowDays: parsed.data.windowDays,
          provider: parsed.data.provider ?? "dataforseo",
        },
        deps
      );
      return res.json(answer);
    } catch (err) {
      return fail(res, err, "backlink check");
    }
  });

  router.get("/orgs/backlinks", async (req: AuthenticatedRequest, res) => {
    try {
      const { identity, brandId } = identityOf(req);
      const rows = await deps.store.listKept(identity.orgId, brandId);
      return res.json({ brandId, count: rows.length, links: rows.map(wireLink) });
    } catch (err) {
      return fail(res, err, "backlink list");
    }
  });

  router.post("/orgs/backlinks/link-gaps", async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = LinkGapRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      const { identity, brandId } = identityOf(req);
      const competitors: string[] = [];
      for (const c of parsed.data.competitors) {
        const d = siteDomainOf(c);
        if (!d) throw new BacklinkError("invalid_competitors", 400, `"${c}" is not a domain`);
        competitors.push(d);
      }
      const answer = await runLinkGap(
        {
          identity,
          brandId,
          idempotencyKey: parsed.data.idempotencyKey,
          competitors,
          minCompetitors: parsed.data.minCompetitors,
          minDomainRank: parsed.data.minDomainRank,
          maxSpamScore: parsed.data.maxSpamScore,
          provider: parsed.data.provider ?? "dataforseo",
        },
        deps
      );
      return res.json(answer);
    } catch (err) {
      return fail(res, err, "link gap");
    }
  });

  return router;
}

export default buildBacklinkRouter({ store: drizzleBacklinkStore, brandDomain: (id) => brandSiteDomain(id) });
