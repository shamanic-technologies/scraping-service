import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { CompanyResearchQuerySchema, PageReadsQuerySchema } from "../schemas.js";
import { normalizeUrl } from "../lib/firecrawl.js";
import { companyDomainOf } from "../lib/outcome-declaration.js";
import {
  COMPANY_RESEARCHED_OUTCOME_KEY,
  DEFAULT_LIMIT,
  MAX_DOMAINS,
  MAX_LIMIT_WITH_CONTENT,
  MAX_URLS,
  PAGE_READ_OUTCOME_KEY,
  decodeCursor,
  pageKeyOf,
  pageOf,
  splitList,
  wireCompanyResearched,
  wirePageRead,
  type ProviderReadStore,
  type ReadCursor,
} from "../lib/provider-reads.js";
import { drizzleProviderReadStore } from "../lib/provider-reads-store.js";
import { errorMessage } from "../lib/db-error.js";

class BadQuery extends Error {}

function cursorOf(before: string | undefined): ReadCursor | undefined {
  if (before === undefined) return undefined;
  const c = decodeCursor(before);
  if (!c) throw new BadQuery("before is not a cursor this read returned (pass the previous page's nextBefore unchanged)");
  return c;
}

function isUrl(u: string): boolean {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * Provider reads (ENGINE-GET-ASK-1123): GET only, org-scoped by x-org-id, no spend, no run,
 * 200 with an empty list when the org holds nothing.
 */
export function buildProviderReadsRouter(deps: { store: ProviderReadStore; now?: () => Date }): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  function fail(res: Response, err: unknown, what: string) {
    if (err instanceof BadQuery) return res.status(400).json({ error: "Invalid request", message: err.message });
    console.error(`[scraping-service] ${what} failed:`, err);
    return res.status(500).json({ error: errorMessage(err, "Internal server error") });
  }

  router.get("/orgs/page-reads", async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = PageReadsQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      const q = parsed.data;

      const withContent = q.includeContent === "true";
      if (withContent && q.limit !== undefined && q.limit > MAX_LIMIT_WITH_CONTENT) {
        throw new BadQuery(`limit is at most ${MAX_LIMIT_WITH_CONTENT} with includeContent=true`);
      }
      const limit = q.limit ?? (withContent ? MAX_LIMIT_WITH_CONTENT : DEFAULT_LIMIT);

      let pageKeys: string[] | undefined;
      if (q.urls !== undefined) {
        const urls = splitList(q.urls);
        if (urls.length < 1 || urls.length > MAX_URLS) throw new BadQuery(`urls takes 1 to ${MAX_URLS} URLs`);
        const bad = urls.find((u) => !isUrl(u));
        if (bad) throw new BadQuery(`"${bad}" is not a URL (include the scheme, e.g. https://acme.com/pricing)`);
        // normalizeUrl is the key the 7-day store uses; pageKeyOf is its SQL-computable twin. Same value on ordinary URLs.
        pageKeys = [...new Set(urls.flatMap((u) => [normalizeUrl(u), pageKeyOf(u)]))];
      }

      let domain: string | undefined;
      if (q.domain !== undefined) {
        const d = companyDomainOf(q.domain);
        if (!d) throw new BadQuery(`"${q.domain}" is not a domain (e.g. acme.com)`);
        domain = d;
      }

      const rows = await deps.store.listReads({
        orgId: req.orgId!,
        kind: PAGE_READ_OUTCOME_KEY,
        pageKeys,
        domain,
        since: q.since ? new Date(q.since) : undefined,
        before: cursorOf(q.before),
        limit: limit + 1,
        withContent,
      });
      const { page, nextBefore, hasMore } = pageOf(rows, limit);
      const at = now();
      return res.json({ units: page.map((r) => wirePageRead(r, at, withContent)), nextBefore, hasMore });
    } catch (err) {
      return fail(res, err, "page reads");
    }
  });

  router.get("/orgs/company-research", async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = CompanyResearchQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      const q = parsed.data;
      const limit = q.limit ?? DEFAULT_LIMIT;

      let domains: string[] | undefined;
      if (q.domains !== undefined) {
        const raw = splitList(q.domains);
        if (raw.length < 1 || raw.length > MAX_DOMAINS) throw new BadQuery(`domains takes 1 to ${MAX_DOMAINS} domains`);
        domains = [];
        for (const r of raw) {
          const d = companyDomainOf(r);
          if (!d) throw new BadQuery(`"${r}" is not a domain (e.g. acme.com)`);
          if (!domains.includes(d)) domains.push(d);
        }
      }

      const rows = await deps.store.listReads({
        orgId: req.orgId!,
        kind: COMPANY_RESEARCHED_OUTCOME_KEY,
        domains,
        brandId: q.brandId,
        campaignId: q.campaignId,
        since: q.since ? new Date(q.since) : undefined,
        before: cursorOf(q.before),
        limit: limit + 1,
        withContent: false,
      });
      const { page, nextBefore, hasMore } = pageOf(rows, limit);
      const at = now();
      const units = page.map((r) => wireCompanyResearched(r, at)).filter((u) => u !== null);
      return res.json({ units, nextBefore, hasMore });
    } catch (err) {
      return fail(res, err, "company research");
    }
  });

  return router;
}

export default buildProviderReadsRouter({ store: drizzleProviderReadStore });
