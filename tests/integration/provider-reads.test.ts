import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { scrapeRequests, scrapeResults } from "../../src/db/schema.js";
import { drizzleProviderReadStore } from "../../src/lib/provider-reads-store.js";
import { companyDomainSql, pageKeySql, pageOf, type ReadFilter } from "../../src/lib/provider-reads.js";
import { companyDomainOf } from "../../src/lib/outcome-declaration.js";
import { normalizeUrl } from "../../src/lib/firecrawl.js";
import { URL_KEY_CASES } from "../fixtures/url-keys.js";

/**
 * Provider reads against real Postgres (ENGINE-GET-ASK-1123): the SQL twins of the url keys
 * return what the JS returns, and the store's filters, org scope and keyset cursor hold.
 */
const ORG = `org-reads-${randomUUID()}`;
const OTHER_ORG = `org-reads-other-${randomUUID()}`;
const T0 = new Date("2026-11-10T00:00:00.000Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const base = (over: Partial<typeof scrapeRequests.$inferInsert> & { url: string; createdAt: Date }) => ({
  sourceService: "workflow-service",
  orgId: ORG,
  provider: "scrape-do",
  status: "completed",
  runId: randomUUID(),
  completedAt: new Date(over.createdAt.getTime() + 1000),
  ...over,
});

const ids: string[] = [];
const list = (f: Partial<ReadFilter>) => drizzleProviderReadStore.listReads({ orgId: ORG, kind: "page_read", limit: 100, withContent: false, ...f });
const urls = async (f: Partial<ReadFilter>) => (await list(f)).map((r) => r.url);

beforeAll(async () => {
  const rows = await db
    .insert(scrapeRequests)
    .values([
      base({ url: "http://acme.com/pricing", createdAt: at(1), outcomeKey: "company_researched", brandIds: ["b-1", "b-2"], campaignId: "c-1", workflowSlug: "sales-cold-email-outreach-v3" }),
      base({ url: "https://WWW.Acme.com:8443/Pricing/?utm=x#plans", createdAt: at(2), outcomeKey: "company_researched", brandIds: ["b-2"] }),
      base({ url: "https://blog.acme.com/pricing", createdAt: at(3) }),
      base({ url: "https://notacme.com/pricing", createdAt: at(4) }),
      base({ url: "https://globex.io/", createdAt: at(5), outcomeKey: "company_researched", campaignId: "c-1" }),
      base({ url: "http://127.0.0.1:3000/x", createdAt: at(6), outcomeKey: "company_researched" }), // no company domain
      base({ url: "https://norun.com", createdAt: at(7), outcomeKey: "company_researched", runId: null }),
      base({ url: "https://failed.com", createdAt: at(8), outcomeKey: "company_researched", status: "failed" }),
      base({ url: "https://other-org.com", createdAt: at(9), outcomeKey: "company_researched", orgId: OTHER_ORG }),
    ])
    .returning({ id: scrapeRequests.id });
  ids.push(...rows.map((r) => r.id));
  // the stored page of the globex read
  await db.insert(scrapeResults).values({
    requestId: ids[4],
    url: "https://globex.io/",
    normalizedUrl: `globex.io/${randomUUID()}`,
    rawMarkdown: "# Globex",
    rawMetadata: { title: "Globex" },
    resolvedUrl: "https://globex.io/",
    expiresAt: new Date("2026-11-17T00:05:00.000Z"),
  });
});

afterAll(async () => {
  if (ids.length) await db.delete(scrapeRequests).where(inArray(scrapeRequests.id, ids)); // results cascade
});

describe("SQL twins of the url keys", () => {
  it.each(URL_KEY_CASES)("$url", async ({ url, domain, pageKey }) => {
    const rows = (await db.execute(sql`SELECT ${companyDomainSql(sql`${url}::text`)} AS d, ${pageKeySql(sql`${url}::text`)} AS k`)) as unknown as { d: string | null; k: string }[];
    expect(rows[0].d).toBe(domain);
    expect(rows[0].d).toBe(companyDomainOf(url));
    expect(rows[0].k).toBe(pageKey);
    expect(rows[0].k).toBe(normalizeUrl(url));
  });
});

describe("drizzleProviderReadStore.listReads", () => {
  it("page_read: the org's completed rows only, newest first", async () => {
    expect(await urls({})).toEqual([
      "https://norun.com",
      "http://127.0.0.1:3000/x",
      "https://globex.io/",
      "https://notacme.com/pricing",
      "https://blog.acme.com/pricing",
      "https://WWW.Acme.com:8443/Pricing/?utm=x#plans",
      "http://acme.com/pricing",
    ]);
    expect(await drizzleProviderReadStore.listReads({ orgId: `nobody-${randomUUID()}`, kind: "page_read", limit: 10, withContent: false })).toEqual([]);
  });

  it("pageKeys: same host + path whatever the scheme, www., port, query, fragment, slash, case", async () => {
    expect(await urls({ pageKeys: [normalizeUrl("https://acme.com/pricing/")] })).toEqual(["https://WWW.Acme.com:8443/Pricing/?utm=x#plans", "http://acme.com/pricing"]);
  });

  it("domain: the host and its subdomains, not a lookalike", async () => {
    expect(await urls({ domain: "acme.com" })).toEqual(["https://blog.acme.com/pricing", "https://WWW.Acme.com:8443/Pricing/?utm=x#plans", "http://acme.com/pricing"]);
  });

  it("since: completed at or after", async () => {
    expect(await urls({ since: new Date(at(6).getTime() + 1000) })).toEqual(["https://norun.com", "http://127.0.0.1:3000/x"]);
  });

  it("content: held only for the read whose page is stored; carried only when asked", async () => {
    const [plain] = await list({ pageKeys: ["globex.io"] });
    expect(plain.resultId).not.toBeNull();
    expect(plain.resultExpiresAt?.toISOString()).toBe("2026-11-17T00:05:00.000Z");
    expect(plain.markdown).toBeNull();
    const [full] = await list({ pageKeys: ["globex.io"], withContent: true });
    expect(full).toMatchObject({ markdown: "# Globex", metadata: { title: "Globex" }, resolvedUrl: "https://globex.io/" });
    const [none] = await list({ pageKeys: ["notacme.com/pricing"], withContent: true });
    expect(none).toMatchObject({ resultId: null, resultExpiresAt: null, markdown: null });
  });

  it("keyset cursor: pages through every row exactly once", async () => {
    const seen: string[] = [];
    let before: ReadFilter["before"];
    for (let i = 0; i < 10; i++) {
      const rows = await list({ limit: 3, before });
      const { page, hasMore } = pageOf(rows, 2);
      seen.push(...page.map((r) => r.url));
      if (!hasMore) break;
      const last = page[page.length - 1];
      expect(last.cursorTs).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      before = { ts: last.cursorTs, id: last.id };
    }
    expect(seen).toEqual(await urls({}));
  });

  it("company_researched: stated outcome + a run + a company domain, org-scoped", async () => {
    const cr = (f: Partial<ReadFilter>) => urls({ kind: "company_researched", ...f });
    expect(await cr({})).toEqual(["https://globex.io/", "https://WWW.Acme.com:8443/Pricing/?utm=x#plans", "http://acme.com/pricing"]);
    expect(await cr({ domains: ["acme.com"] })).toEqual(["https://WWW.Acme.com:8443/Pricing/?utm=x#plans", "http://acme.com/pricing"]);
    expect(await cr({ domains: ["blog.acme.com"] })).toEqual([]);
    expect(await cr({ brandId: "b-1" })).toEqual(["http://acme.com/pricing"]);
    expect(await cr({ brandId: "b-2" })).toEqual(["https://WWW.Acme.com:8443/Pricing/?utm=x#plans", "http://acme.com/pricing"]);
    expect(await cr({ campaignId: "c-1" })).toEqual(["https://globex.io/", "http://acme.com/pricing"]);
  });

  it("outcome_key is stored and read back on the request row", async () => {
    const [row] = await db.select().from(scrapeRequests).where(eq(scrapeRequests.id, ids[0]));
    expect(row.outcomeKey).toBe("company_researched");
  });
});
