import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "fs";
import { join } from "path";
import { serviceAuth } from "../../src/middleware/auth.js";
import { buildProviderReadsRouter } from "../../src/routes/provider-reads.js";
import { companyDomainOf } from "../../src/lib/outcome-declaration.js";
import { normalizeUrl } from "../../src/lib/firecrawl.js";
import {
  cursorTsOf,
  decodeCursor,
  encodeCursor,
  pageKeyOf,
  splitList,
  type ProviderReadStore,
  type ReadFilter,
  type ReadRow,
} from "../../src/lib/provider-reads.js";
import { URL_KEY_CASES } from "../fixtures/url-keys.js";

const ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const OTHER_ORG = "0a0a0a0a-8f72-4f0a-a150-f473746df1e6";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const DAY = 86_400_000;

type Seed = ReadRow & { orgId: string; status: string };

let n = 0;
/** A stored read, `daysAgo` days before NOW. Ids grow with insertion so order ties are deterministic. */
function seed(over: Partial<Seed> & { url: string; daysAgo: number }): Seed {
  n++;
  const createdAt = new Date(NOW.getTime() - over.daysAgo * DAY);
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    orgId: ORG,
    status: "completed",
    provider: "scrape-do",
    runId: `run-${n}`,
    outcomeKey: null,
    brandIds: null,
    campaignId: null,
    workflowSlug: null,
    createdAt,
    cursorTs: cursorTsOf(createdAt),
    completedAt: new Date(createdAt.getTime() + 2000),
    resultId: null,
    resultExpiresAt: null,
    markdown: null,
    metadata: null,
    resolvedUrl: null,
    ...over,
  };
}

/** The reference semantics of a read, in JS. The Postgres store is checked against the same cases in tests/integration. */
function memoryStore(rows: Seed[]): ProviderReadStore & { calls: ReadFilter[] } {
  const calls: ReadFilter[] = [];
  return {
    calls,
    async listReads(f) {
      calls.push(f);
      return rows
        .filter((r) => r.orgId === f.orgId && r.status === "completed")
        .filter((r) => f.kind !== "company_researched" || (r.outcomeKey === "company_researched" && r.runId !== null && companyDomainOf(r.url) !== null))
        .filter((r) => !f.pageKeys?.length || f.pageKeys.includes(pageKeyOf(r.url)))
        .filter((r) => {
          if (!f.domain) return true;
          const d = companyDomainOf(r.url);
          return d !== null && (d === f.domain || d.endsWith("." + f.domain));
        })
        .filter((r) => !f.domains?.length || f.domains.includes(companyDomainOf(r.url) ?? ""))
        .filter((r) => !f.brandId || (r.brandIds ?? []).includes(f.brandId))
        .filter((r) => !f.campaignId || r.campaignId === f.campaignId)
        .filter((r) => !f.since || (r.completedAt !== null && r.completedAt >= f.since))
        .filter((r) => !f.before || r.cursorTs < f.before.ts || (r.cursorTs === f.before.ts && r.id < f.before.id))
        .sort((a, b) => (a.cursorTs === b.cursorTs ? (a.id < b.id ? 1 : -1) : a.cursorTs < b.cursorTs ? 1 : -1))
        .slice(0, f.limit)
        .map((r) => (f.withContent ? r : { ...r, markdown: null, metadata: null, resolvedUrl: null }));
    },
  };
}

function app(store: ProviderReadStore) {
  const a = express();
  a.use(express.json());
  process.env.SCRAPING_SERVICE_API_KEY = "test-api-key";
  a.use(serviceAuth);
  a.use(buildProviderReadsRouter({ store, now: () => NOW }));
  return a;
}

const H = { "x-api-key": "test-api-key", "x-org-id": ORG, "x-user-id": "u-1", "x-run-id": "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  n = 0;
});

describe("url keys: JS side (SQL twins checked in tests/integration/provider-reads.test.ts)", () => {
  it.each(URL_KEY_CASES)("$url -> domain $domain, page $pageKey", ({ url, domain, pageKey }) => {
    expect(companyDomainOf(url)).toBe(domain);
    expect(pageKeyOf(url)).toBe(pageKey);
  });

  it("pageKeyOf equals normalizeUrl (the 7-day store's key) on every case", () => {
    for (const c of URL_KEY_CASES) expect(pageKeyOf(c.url), c.url).toBe(normalizeUrl(c.url));
  });

  it("splitList: comma-separated, repeated, trimmed, deduplicated", () => {
    expect(splitList("a, b,,a")).toEqual(["a", "b"]);
    expect(splitList(["a,b", "c", "b"])).toEqual(["a", "b", "c"]);
    expect(splitList(undefined)).toEqual([]);
  });

  it("cursor round-trips and refuses anything else", () => {
    const c = { ts: "2026-11-20T10:00:00.123456Z", id: "00000000-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(Buffer.from("2026-11-20|x").toString("base64url"))).toBeNull();
  });
});

describe("GET /orgs/page-reads (provider:page_read)", () => {
  it("lists the caller org's completed reads only, newest first, with the Unit shape", async () => {
    const store = memoryStore([
      seed({ url: "https://www.Acme.com/pricing", daysAgo: 3, outcomeKey: "company_researched", brandIds: ["b-1"], campaignId: "c-1" }),
      seed({ url: "https://globex.io/", daysAgo: 1, provider: "firecrawl", resultId: "9b1f0c1e-7a57-4a55-9d0a-0d1d2f3a4b5c", resultExpiresAt: new Date(NOW.getTime() + 6 * DAY), markdown: "# Globex", metadata: { title: "Globex" }, resolvedUrl: "https://globex.io/" }),
      seed({ url: "https://other-org.com", daysAgo: 1, orgId: OTHER_ORG }),
      seed({ url: "https://failed.com", daysAgo: 1, status: "failed" }),
    ]);
    const res = await request(app(store)).get("/orgs/page-reads").set(H);
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextBefore).toBeNull();
    expect(res.body.units.map((u: any) => u.url)).toEqual(["https://globex.io/", "https://www.Acme.com/pricing"]);
    expect(res.body.units[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000002",
      url: "https://globex.io/",
      domain: "globex.io",
      readAt: "2026-11-23T12:00:02.000Z",
      ageDays: 1,
      runId: "run-2",
      provider: "firecrawl",
      outcomeKey: null,
      brandIds: [],
      campaignId: null,
      // default includeContent=false: says the content is held, never carries it
      content: { held: true, resultId: "9b1f0c1e-7a57-4a55-9d0a-0d1d2f3a4b5c", expiresAt: "2026-11-30T12:00:00.000Z" },
    });
    expect(res.body.units[1]).toMatchObject({
      domain: "acme.com",
      ageDays: 3,
      outcomeKey: "company_researched",
      brandIds: ["b-1"],
      campaignId: "c-1",
      content: { held: false, resultId: null, expiresAt: null },
    });
    expect(store.calls[0]).toMatchObject({ orgId: ORG, kind: "page_read", withContent: false, limit: 51 });
  });

  it("nothing held = 200 with an empty list, never 404", async () => {
    const res = await request(app(memoryStore([seed({ url: "https://x.com", daysAgo: 1, orgId: OTHER_ORG })]))).get("/orgs/page-reads").set(H);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ units: [], nextBefore: null, hasMore: false });
  });

  it("urls: same host + path, ignoring scheme, www., port, query, fragment, trailing slash and case", async () => {
    const store = memoryStore([
      seed({ url: "http://acme.com/pricing", daysAgo: 5 }),
      seed({ url: "https://ACME.com:8443/Pricing/#plans", daysAgo: 4 }),
      seed({ url: "https://acme.com/pricing/eu", daysAgo: 3 }),
      seed({ url: "https://blog.acme.com/pricing", daysAgo: 2 }),
      seed({ url: "https://globex.io/about", daysAgo: 1 }),
    ]);
    const res = await request(app(store)).get("/orgs/page-reads").query({ urls: "https://www.Acme.com/pricing/?utm=x, https://globex.io/about" }).set(H);
    expect(res.status).toBe(200);
    expect(res.body.units.map((u: any) => u.url)).toEqual(["https://globex.io/about", "https://ACME.com:8443/Pricing/#plans", "http://acme.com/pricing"]);
    expect(store.calls[0].pageKeys).toEqual(["acme.com/pricing", "globex.io/about"]);

    // repeated parameter = same list
    const repeated = await request(app(store)).get("/orgs/page-reads?urls=https://acme.com/pricing&urls=https://globex.io/about").set(H);
    expect(repeated.body.units).toHaveLength(3);
  });

  it("urls: refuses a value that is not a URL, an empty list, and more than 50", async () => {
    const a = app(memoryStore([]));
    expect((await request(a).get("/orgs/page-reads").query({ urls: "acme.com" }).set(H)).status).toBe(400);
    expect((await request(a).get("/orgs/page-reads").query({ urls: " , " }).set(H)).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `https://acme.com/p${i}`).join(",");
    expect((await request(a).get("/orgs/page-reads").query({ urls: many }).set(H)).status).toBe(400);
  });

  it("domain: that host and its subdomains, www. ignored; not a lookalike", async () => {
    const store = memoryStore([
      seed({ url: "https://www.acme.com/a", daysAgo: 4 }),
      seed({ url: "https://blog.acme.com/b", daysAgo: 3 }),
      seed({ url: "https://notacme.com/c", daysAgo: 2 }),
      seed({ url: "https://acme.com.evil.io/d", daysAgo: 1 }),
    ]);
    const res = await request(app(store)).get("/orgs/page-reads").query({ domain: "https://WWW.Acme.com/" }).set(H);
    expect(res.status).toBe(200);
    expect(res.body.units.map((u: any) => u.url)).toEqual(["https://blog.acme.com/b", "https://www.acme.com/a"]);
    expect(store.calls[0].domain).toBe("acme.com");
    expect((await request(app(store)).get("/orgs/page-reads").query({ domain: "not a domain" }).set(H)).status).toBe(400);
  });

  it("since: read at or after", async () => {
    const store = memoryStore([seed({ url: "https://old.com", daysAgo: 10 }), seed({ url: "https://new.com", daysAgo: 1 })]);
    const res = await request(app(store)).get("/orgs/page-reads").query({ since: "2026-11-20T00:00:00Z" }).set(H);
    expect(res.body.units.map((u: any) => u.url)).toEqual(["https://new.com"]);
    expect((await request(app(store)).get("/orgs/page-reads").query({ since: "yesterday" }).set(H)).status).toBe(400);
  });

  it("limit + before: pages through every Unit once, newest first", async () => {
    const store = memoryStore(Array.from({ length: 5 }, (_, i) => seed({ url: `https://acme.com/p${i}`, daysAgo: 5 - i })));
    const p1 = await request(app(store)).get("/orgs/page-reads").query({ limit: 2 }).set(H);
    expect(p1.body.units.map((u: any) => u.url)).toEqual(["https://acme.com/p4", "https://acme.com/p3"]);
    expect(p1.body.hasMore).toBe(true);
    expect(typeof p1.body.nextBefore).toBe("string");
    const p2 = await request(app(store)).get("/orgs/page-reads").query({ limit: 2, before: p1.body.nextBefore }).set(H);
    expect(p2.body.units.map((u: any) => u.url)).toEqual(["https://acme.com/p2", "https://acme.com/p1"]);
    const p3 = await request(app(store)).get("/orgs/page-reads").query({ limit: 2, before: p2.body.nextBefore }).set(H);
    expect(p3.body.units.map((u: any) => u.url)).toEqual(["https://acme.com/p0"]);
    expect(p3.body).toMatchObject({ hasMore: false, nextBefore: null });
  });

  it("refuses a cursor it did not issue and a limit out of range", async () => {
    const a = app(memoryStore([]));
    expect((await request(a).get("/orgs/page-reads").query({ before: "abc" }).set(H)).status).toBe(400);
    expect((await request(a).get("/orgs/page-reads").query({ limit: 0 }).set(H)).status).toBe(400);
    expect((await request(a).get("/orgs/page-reads").query({ limit: 201 }).set(H)).status).toBe(400);
    expect((await request(a).get("/orgs/page-reads").query({ includeContent: "yes" }).set(H)).status).toBe(400);
  });

  it("includeContent=true: carries the page of a held read, caps limit at 20 (default 20)", async () => {
    const store = memoryStore([
      seed({ url: "https://gone.com", daysAgo: 9 }),
      seed({ url: "https://globex.io/", daysAgo: 1, resultId: "9b1f0c1e-7a57-4a55-9d0a-0d1d2f3a4b5c", resultExpiresAt: new Date(NOW.getTime() + 6 * DAY), markdown: "# Globex", metadata: { ogTitle: "Globex OG" }, resolvedUrl: "https://www.globex.io/home" }),
    ]);
    const res = await request(app(store)).get("/orgs/page-reads").query({ includeContent: "true" }).set(H);
    expect(res.status).toBe(200);
    expect(store.calls[0]).toMatchObject({ withContent: true, limit: 21 });
    expect(res.body.units[0].content).toEqual({
      held: true,
      resultId: "9b1f0c1e-7a57-4a55-9d0a-0d1d2f3a4b5c",
      expiresAt: "2026-11-30T12:00:00.000Z",
      markdown: "# Globex",
      title: "Globex OG",
      resolvedUrl: "https://www.globex.io/home",
    });
    expect(res.body.units[1].content).toEqual({ held: false, resultId: null, expiresAt: null });

    expect((await request(app(store)).get("/orgs/page-reads").query({ includeContent: "true", limit: 20 }).set(H)).status).toBe(200);
    const over = await request(app(store)).get("/orgs/page-reads").query({ includeContent: "true", limit: 21 }).set(H);
    expect(over.status).toBe(400);
    // the same limit is fine without the content
    expect((await request(app(store)).get("/orgs/page-reads").query({ limit: 21 }).set(H)).status).toBe(200);
  });

  it("requires the identity headers (org-scoped)", async () => {
    const { "x-org-id": _o, ...noOrg } = H;
    expect((await request(app(memoryStore([]))).get("/orgs/page-reads").set(noOrg)).status).toBe(400);
  });
});

describe("GET /orgs/company-research (provider:company_researched)", () => {
  const cr = (over: Partial<Seed> & { url: string; daysAgo: number }) => seed({ outcomeKey: "company_researched", workflowSlug: "sales-cold-email-outreach-v3", ...over });

  it("lists the caller org's declared Units only, with subject and run", async () => {
    const store = memoryStore([
      cr({ url: "https://www.Acme.com/about", daysAgo: 2, brandIds: ["b-1"], campaignId: "c-1" }),
      seed({ url: "https://client-site.com", daysAgo: 1 }), // a read with no stated outcome (brand setup)
      cr({ url: "https://other-org.com", daysAgo: 1, orgId: OTHER_ORG }),
      cr({ url: "https://failed.com", daysAgo: 1, status: "failed" }),
      cr({ url: "http://127.0.0.1/x", daysAgo: 1 }), // names no company: nothing was declared
      cr({ url: "https://norun.com", daysAgo: 1, runId: null }), // no run: nothing was declared
    ]);
    const res = await request(app(store)).get("/orgs/company-research").set(H);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      units: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          subject: { subjectService: "lead-service", subjectId: "acme.com" },
          url: "https://www.Acme.com/about",
          researchedAt: "2026-11-22T12:00:02.000Z",
          ageDays: 2,
          runId: "run-1",
          brandIds: ["b-1"],
          campaignId: "c-1",
          workflowSlug: "sales-cold-email-outreach-v3",
          content: { held: false, resultId: null, expiresAt: null },
        },
      ],
      nextBefore: null,
      hasMore: false,
    });
    expect(store.calls[0]).toMatchObject({ orgId: ORG, kind: "company_researched", withContent: false, limit: 51 });
  });

  it("nothing held = 200 with an empty list, never 404", async () => {
    const res = await request(app(memoryStore([]))).get("/orgs/company-research").set(H);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ units: [], nextBefore: null, hasMore: false });
  });

  it("domains: exact subject ids, normalized like the subject (comma-separated or repeated)", async () => {
    const store = memoryStore([
      cr({ url: "https://acme.com/about", daysAgo: 3 }),
      cr({ url: "https://blog.acme.com/", daysAgo: 2 }),
      cr({ url: "https://globex.io", daysAgo: 1 }),
    ]);
    const res = await request(app(store)).get("/orgs/company-research").query({ domains: "https://WWW.Acme.com/x, globex.io" }).set(H);
    expect(res.body.units.map((u: any) => u.subject.subjectId)).toEqual(["globex.io", "acme.com"]);
    expect(store.calls[0].domains).toEqual(["acme.com", "globex.io"]);
    const repeated = await request(app(store)).get("/orgs/company-research?domains=acme.com&domains=blog.acme.com").set(H);
    expect(repeated.body.units.map((u: any) => u.subject.subjectId)).toEqual(["blog.acme.com", "acme.com"]);

    expect((await request(app(store)).get("/orgs/company-research").query({ domains: "nope" }).set(H)).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `d${i}.com`).join(",");
    expect((await request(app(store)).get("/orgs/company-research").query({ domains: many }).set(H)).status).toBe(400);
  });

  it("brandId, campaignId and since filter", async () => {
    const store = memoryStore([
      cr({ url: "https://a.com", daysAgo: 10, brandIds: ["b-1", "b-2"], campaignId: "c-1" }),
      cr({ url: "https://b.com", daysAgo: 2, brandIds: ["b-2"], campaignId: "c-2" }),
      cr({ url: "https://c.com", daysAgo: 1, brandIds: null, campaignId: "c-1" }),
    ]);
    const ids = async (q: Record<string, string>) => (await request(app(store)).get("/orgs/company-research").query(q).set(H)).body.units.map((u: any) => u.subject.subjectId);
    expect(await ids({ brandId: "b-2" })).toEqual(["b.com", "a.com"]);
    expect(await ids({ brandId: "b-1" })).toEqual(["a.com"]);
    expect(await ids({ campaignId: "c-1" })).toEqual(["c.com", "a.com"]);
    expect(await ids({ since: "2026-11-20T00:00:00Z" })).toEqual(["c.com", "b.com"]);
    expect(await ids({ brandId: "b-2", since: "2026-11-20T00:00:00Z" })).toEqual(["b.com"]);
  });

  it("limit + before: pages through every Unit once", async () => {
    const store = memoryStore(Array.from({ length: 3 }, (_, i) => cr({ url: `https://c${i}.com`, daysAgo: 3 - i })));
    const p1 = await request(app(store)).get("/orgs/company-research").query({ limit: 2 }).set(H);
    expect(p1.body.units.map((u: any) => u.subject.subjectId)).toEqual(["c2.com", "c1.com"]);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await request(app(store)).get("/orgs/company-research").query({ limit: 2, before: p1.body.nextBefore }).set(H);
    expect(p2.body.units.map((u: any) => u.subject.subjectId)).toEqual(["c0.com"]);
    expect(p2.body).toMatchObject({ hasMore: false, nextBefore: null });
    expect((await request(app(store)).get("/orgs/company-research").query({ before: "zzz" }).set(H)).status).toBe(400);
  });
});

describe("openapi.json files the three provider reads (ENGINE-GET-ASK-1123)", () => {
  const spec = JSON.parse(readFileSync(join(process.cwd(), "openapi.json"), "utf-8"));

  it.each([
    ["/orgs/page-reads", "listPageReadUnits", "provider:page_read"],
    ["/orgs/company-research", "listCompanyResearchedUnits", "provider:company_researched"],
    ["/orgs/backlinks", "listBacklinkEarnedUnits", "provider:backlink_earned"],
  ])("GET %s = %s tagged %s", (path, operationId, tag) => {
    const op = spec.paths[path]?.get;
    expect(op, `GET ${path} missing from openapi.json (run npm run generate:openapi)`).toBeDefined();
    expect(op.operationId).toBe(operationId);
    expect(op.tags).toEqual([tag]);
    expect(op.responses["200"].content["application/json"].schema).toBeDefined();
    // every query filter is explained in words
    for (const p of op.parameters ?? []) expect(p.description, `${path} ?${p.name}`).toBeTruthy();
  });

  it("every provider:* tag sits on exactly one operation, each with a unique operationId", () => {
    const tagged: { tag: string; operationId: string }[] = [];
    for (const methods of Object.values<any>(spec.paths)) {
      for (const op of Object.values<any>(methods)) {
        for (const t of op.tags ?? []) if (t.startsWith("provider:")) tagged.push({ tag: t, operationId: op.operationId });
      }
    }
    expect(tagged.map((t) => t.tag).sort()).toEqual(["provider:backlink_earned", "provider:company_researched", "provider:page_read"]);
    expect(new Set(tagged.map((t) => t.operationId)).size).toBe(3);
  });

  it("page reads document their filters; POST /scrape documents maxAgeDays (0 to 7)", () => {
    const names = (path: string) => spec.paths[path].get.parameters.map((p: any) => p.name).sort();
    expect(names("/orgs/page-reads")).toEqual(["before", "domain", "includeContent", "limit", "since", "urls"]);
    expect(names("/orgs/company-research")).toEqual(["before", "brandId", "campaignId", "domains", "limit", "since"]);
    expect(names("/orgs/backlinks")).toEqual(["declared", "ids", "since"]);
    expect(spec.paths["/orgs/backlinks"].get.parameters.every((p: any) => p.required !== true)).toBe(true);
    const maxAge = spec.components.schemas.ScrapeRequest.properties.maxAgeDays;
    expect(maxAge).toMatchObject({ type: "integer", minimum: 0, maximum: 7 });
    expect(maxAge.description).toMatch(/7 days/);
    expect(spec.components.schemas.ScrapeRequest.required ?? []).not.toContain("maxAgeDays");
  });
});
