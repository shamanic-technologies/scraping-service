import { and, arrayContains, desc, eq, gte, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { scrapeRequests, scrapeResults } from "../db/schema.js";
import {
  COMPANY_RESEARCHED_OUTCOME_KEY,
  companyDomainSql,
  pageKeySql,
  type ProviderReadStore,
  type ReadFilter,
  type ReadRow,
} from "./provider-reads.js";

/** The WHERE of a read. Always scoped by org_id (tenant isolation) and to completed rows. */
export function readConditions(f: ReadFilter): SQL[] {
  const domain = companyDomainSql(scrapeRequests.url);
  const where: SQL[] = [eq(scrapeRequests.orgId, f.orgId), eq(scrapeRequests.status, "completed")];
  if (f.kind === COMPANY_RESEARCHED_OUTCOME_KEY) {
    // What the scrape's run declared: the caller stated the outcome, a run exists, the url names a company.
    where.push(eq(scrapeRequests.outcomeKey, COMPANY_RESEARCHED_OUTCOME_KEY), isNotNull(scrapeRequests.runId), sql`${domain} IS NOT NULL`);
  }
  if (f.pageKeys?.length) where.push(inArray(pageKeySql(scrapeRequests.url), f.pageKeys));
  // `f.domain` went through companyDomainOf ([a-z0-9.-] only): no LIKE wildcard can reach here.
  if (f.domain) where.push(or(sql`${domain} = ${f.domain}`, sql`${domain} LIKE ${"%." + f.domain}`)!);
  if (f.domains?.length) where.push(inArray(domain, f.domains));
  if (f.brandId) where.push(arrayContains(scrapeRequests.brandIds, [f.brandId]));
  if (f.campaignId) where.push(eq(scrapeRequests.campaignId, f.campaignId));
  if (f.since) where.push(gte(scrapeRequests.completedAt, f.since));
  if (f.before) {
    where.push(sql`(${scrapeRequests.createdAt}, ${scrapeRequests.id}) < (${f.before.ts}::timestamptz, ${f.before.id}::uuid)`);
  }
  return where;
}

/** Postgres-backed reads. The page content is only pulled (TOAST) when the caller asks for it. */
export const drizzleProviderReadStore: ProviderReadStore = {
  async listReads(f: ReadFilter): Promise<ReadRow[]> {
    const rows = await db
      .select({
        id: scrapeRequests.id,
        url: scrapeRequests.url,
        provider: scrapeRequests.provider,
        runId: scrapeRequests.runId,
        outcomeKey: scrapeRequests.outcomeKey,
        brandIds: scrapeRequests.brandIds,
        campaignId: scrapeRequests.campaignId,
        workflowSlug: scrapeRequests.workflowSlug,
        createdAt: scrapeRequests.createdAt,
        cursorTs: sql<string>`to_char(${scrapeRequests.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        completedAt: scrapeRequests.completedAt,
        resultId: scrapeResults.id,
        resultExpiresAt: scrapeResults.expiresAt,
        markdown: f.withContent ? scrapeResults.rawMarkdown : sql<string | null>`NULL`,
        metadata: f.withContent ? scrapeResults.rawMetadata : sql<unknown>`NULL`,
        resolvedUrl: f.withContent ? scrapeResults.resolvedUrl : sql<string | null>`NULL`,
      })
      .from(scrapeRequests)
      .leftJoin(scrapeResults, eq(scrapeResults.requestId, scrapeRequests.id))
      .where(and(...readConditions(f)))
      .orderBy(desc(scrapeRequests.createdAt), desc(scrapeRequests.id))
      .limit(f.limit);
    return rows;
  },
};
