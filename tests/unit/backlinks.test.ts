import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { serviceAuth } from "../../src/middleware/auth.js";
import { buildBacklinkRouter } from "../../src/routes/backlinks.js";
import { BacklinkError } from "../../src/lib/treg-meter.js";
import { htmlLinksTo, verifyLink } from "../../src/lib/link-verify.js";
import { matchNewDomain } from "../../src/lib/backlinks.js";
import type { BacklinkStore, CheckRow, GapRow, KeptLinkRow } from "../../src/lib/backlinks.js";
import type { Verification } from "../../src/lib/link-verify.js";

process.env.RUNS_SERVICE_URL = "http://runs";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.BILLING_SERVICE_URL = "http://billing";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.KEY_SERVICE_URL = "http://keys";
process.env.KEY_SERVICE_API_KEY = "keys-key";

const ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const RUN = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-09T12:00:00Z");

// ---------- in-memory store ----------
function memoryStore(): BacklinkStore & { kept: (KeptLinkRow & { orgId: string; brandId: string })[]; checks: (CheckRow & { createdAt: number })[] } {
  const checks: (CheckRow & { createdAt: number })[] = [];
  const kept: (KeptLinkRow & { orgId: string; brandId: string })[] = [];
  const gaps: (GapRow & { key: string })[] = [];
  let tick = 0;
  return {
    checks,
    kept,
    async findCheck(o, b, k) {
      return checks.find((c) => c.orgId === o && c.brandId === b && c.idempotencyKey === k) ?? null;
    },
    async insertCheck(row) {
      if (checks.some((c) => c.orgId === row.orgId && c.brandId === row.brandId && c.idempotencyKey === row.idempotencyKey)) return null;
      const c = { id: randomUUID(), orgId: row.orgId, brandId: row.brandId, idempotencyKey: row.idempotencyKey, runId: row.runId, status: "running" as const, windowStart: row.windowStart, answer: null, createdAt: tick++ };
      checks.push(c);
      return c;
    },
    async restartCheck(id, runId, _d, ws) {
      const c = checks.find((x) => x.id === id)!;
      Object.assign(c, { status: "running", runId, windowStart: ws });
    },
    async windowStart(o, b) {
      const first = checks.filter((c) => c.orgId === o && c.brandId === b).sort((x, y) => x.createdAt - y.createdAt)[0];
      return first?.windowStart ?? null;
    },
    async completeCheck(id, answer) {
      Object.assign(checks.find((x) => x.id === id)!, { status: "completed", answer });
    },
    async failCheck(id) {
      Object.assign(checks.find((x) => x.id === id)!, { status: "failed" });
    },
    async keptDomains(o, b) {
      return new Set(kept.filter((k) => k.orgId === o && k.brandId === b).map((k) => k.referringDomain));
    },
    async insertKept(o, b, rows) {
      const out: KeptLinkRow[] = [];
      for (const r of rows) {
        if (kept.some((k) => k.orgId === o && k.brandId === b && k.referringDomain === r.referringDomain)) continue;
        const row = { ...r, id: randomUUID(), orgId: o, brandId: b, declaredRunId: null, declaredAt: null, createdAt: new Date() };
        kept.push(row);
        out.push(row);
      }
      return out;
    },
    async undeclared(o, b) {
      return kept.filter((k) => k.orgId === o && k.brandId === b && k.declaredRunId === null);
    },
    async markDeclared(ids, runId) {
      for (const k of kept) if (ids.includes(k.id)) Object.assign(k, { declaredRunId: runId, declaredAt: new Date() });
    },
    async listKept(o, b) {
      return kept.filter((k) => k.orgId === o && k.brandId === b);
    },
    async findGap(_o, _b, k, ck) {
      return gaps.find((g) => g.key === `${k}|${ck}`) ?? null;
    },
    async insertGap(row) {
      const g = { id: randomUUID(), status: "running" as const, answer: null, key: `${row.idempotencyKey}|${row.competitorsKey}` };
      gaps.push(g);
      return g;
    },
    async restartGap(id) {
      Object.assign(gaps.find((g) => g.id === id)!, { status: "running" });
    },
    async completeGap(id, answer) {
      Object.assign(gaps.find((g) => g.id === id)!, { status: "completed", answer });
    },
    async failGap(id) {
      Object.assign(gaps.find((g) => g.id === id)!, { status: "failed" });
    },
  };
}

// ---------- fake fleet (key, billing, runs, treg) ----------
interface Call {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

function dfs(items: unknown[], total = items.length) {
  return { status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ total_count: total, items }] }] };
}

function fleet(opts: {
  referringDomains?: unknown[];
  backlinks?: unknown[];
  gap?: unknown[];
  keySource?: "org" | "platform";
  sufficient?: boolean;
  tregStatus?: number;
  outcomesStatus?: number;
}) {
  const calls: Call[] = [];
  const costs: { runId: string; item: any; id: string; status: string }[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ url, method: init.method ?? "GET", body, headers });
    const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...extra } });
    if (url.startsWith("http://keys/keys/")) return json({ provider: "treg", key: url.includes("treg-org") ? "org-x" : "tok-x", keySource: opts.keySource ?? "platform" });
    if (url === "http://billing/v1/customer_balance/authorize") return json({ sufficient: opts.sufficient ?? true, balance_cents: 1, required_cents: 7 });
    let m = /^http:\/\/runs\/v1\/runs\/([^/]+)\/costs$/.exec(url);
    if (m) {
      const id = randomUUID();
      costs.push({ runId: m[1], item: body.items[0], id, status: body.items[0].status ?? "actual" });
      return json({ costs: [{ id }] }, 201);
    }
    m = /^http:\/\/runs\/v1\/runs\/([^/]+)\/costs\/([^/]+)$/.exec(url);
    if (m) {
      const c = costs.find((x) => x.id === m![2])!;
      c.status = body.status;
      return json({ id: c.id, status: body.status });
    }
    if (/^http:\/\/runs\/v1\/runs\/[^/]+\/outcomes$/.test(url)) {
      const status = opts.outcomesStatus ?? 200;
      return json(status === 200 ? { recordedCount: body.produced.length, alreadyRecordedCount: 0 } : { error: "boom" }, status);
    }
    if (url.startsWith("https://treg.to/call/")) {
      const endpoint = url.slice("https://treg.to/call/".length);
      if (opts.tregStatus && opts.tregStatus !== 200) return json({ error: "upstream down" }, opts.tregStatus, { "x-treg-cost-micro": "0" });
      const items = endpoint === "dataforseo.web.linking_domains.list" ? opts.referringDomains ?? [] : endpoint === "dataforseo.web.backlinks.list" ? opts.backlinks ?? [] : opts.gap ?? [];
      return json(dfs(items), 200, { "x-treg-cost-micro": String(24_000 + 36 * items.length) });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { calls, costs, fetchImpl };
}

function app(store: BacklinkStore, f: ReturnType<typeof fleet>, opts: { site?: string | null; verify?: (u: string) => Verification } = {}) {
  const a = express();
  a.use(express.json());
  process.env.SCRAPING_SERVICE_API_KEY = "test-api-key";
  a.use(serviceAuth);
  a.use(
    buildBacklinkRouter({
      store,
      fetchImpl: f.fetchImpl,
      now: () => NOW,
      verify: async (u) => (opts.verify ? opts.verify(u) : "verified"),
      brandDomain: async () => {
        if (opts.site === null) throw new BacklinkError("brand_has_no_site", 422, "no site");
        return opts.site ?? "distribute.you";
      },
    })
  );
  return a;
}

const H = { "x-api-key": "test-api-key", "x-org-id": ORG, "x-user-id": "u-1", "x-run-id": RUN, "x-brand-id": BRAND, "x-campaign-id": "camp-1" };
const checkBody = (key = "2026-11-09") => ({ outcomeKey: "backlink_earned", idempotencyKey: key, windowDays: 60 });

const RD = [
  { domain: "goalsetting.co", first_seen: "2026-11-03 12:50:41 +00:00", rank: 35, backlinks_spam_score: 2 },
  { domain: "www.sota2.com", first_seen: "2026-10-22 07:27:34 +00:00", rank: 79, backlinks_spam_score: 0 },
];
const BL = [
  { domain_from: "goalsetting.co", url_from: "https://goalsetting.co/qa/x", url_to: "https://distribute.you/", anchor: "Distribute", dofollow: true, domain_from_rank: 35, backlink_spam_score: 2, first_seen: "2026-11-03 12:50:41 +00:00" },
  { domain_from: "blog.sota2.com", url_from: "https://blog.sota2.com/p", url_to: "https://distribute.you/blog", anchor: null, dofollow: false, domain_from_rank: 79, backlink_spam_score: 0, first_seen: "2026-10-22 07:27:34 +00:00" },
  // old domain (first linked before the window) adding a new page: never a new earned link
  { domain_from: "oldfriend.com", url_from: "https://oldfriend.com/new-page", url_to: "https://distribute.you/", anchor: null, dofollow: true, domain_from_rank: 50, backlink_spam_score: 1, first_seen: "2026-11-01 00:00:00 +00:00" },
];

const tregCalls = (f: ReturnType<typeof fleet>) => f.calls.filter((c) => c.url.startsWith("https://treg.to/"));
const outcomeCalls = (f: ReturnType<typeof fleet>) => f.calls.filter((c) => c.url.endsWith("/outcomes"));

describe("POST /orgs/backlinks/checks", () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
  });

  it("first check keeps the new links within the window, declares one Unit each on the caller's run, treg cost actualized on that run", async () => {
    const f = fleet({ referringDomains: RD, backlinks: BL });
    const res = await request(app(store, f)).post("/orgs/backlinks/checks").set(H).send(checkBody());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("new_links_kept");
    expect(res.body.firstCheck).toBe(true);
    expect(res.body.windowStart).toBe("2026-09-10T12:00:00.000Z");
    expect(res.body.newLinks.map((l: any) => l.referringDomain).sort()).toEqual(["goalsetting.co", "sota2.com"]);
    expect(res.body.newLinks.every((l: any) => l.unitDeclared && l.declaredRunId === RUN)).toBe(true);
    expect(res.body.unitsDeclared).toBe(2);

    // window sent to the provider
    expect(tregCalls(f)[0].body[0].filters).toEqual(["first_seen", ">=", "2026-09-10 12:00:00 +00:00"]);

    // Units: one per kept link, on the caller's run, subject = the kept link
    const decl = outcomeCalls(f);
    expect(decl).toHaveLength(1);
    expect(decl[0].url).toBe(`http://runs/v1/runs/${RUN}/outcomes`);
    expect(decl[0].body.produced).toHaveLength(2);
    expect(decl[0].body.produced.every((p: any) => p.outcomeKey === "backlink_earned" && p.subjectService === "scraping-service")).toBe(true);
    expect(decl[0].body.produced.map((p: any) => p.subjectId).sort()).toEqual(store.kept.map((k) => k.id).sort());

    // spend: every hold cancelled, the actual cost = treg's charge, all on the caller's run
    expect(f.costs.every((c) => c.runId === RUN && c.item.costName === "treg-micro-usd")).toBe(true);
    const holds = f.costs.filter((c) => c.item.status === "provisioned");
    expect(holds).toHaveLength(2);
    expect(holds.every((h) => h.status === "cancelled")).toBe(true);
    const actual = f.costs.filter((c) => c.item.status === undefined);
    expect(actual.map((c) => c.item.quantity)).toEqual([24_000 + 36 * 2, 24_000 + 36 * 3]);
    expect(res.body.costMicroUsd).toBe(24_072 + 24_108);
    // platform key: authorized on the org's balance
    expect(f.calls.filter((c) => c.url.includes("authorize"))).toHaveLength(2);
  });

  it("a domain that linked before the window is never a new earned link", async () => {
    const f = fleet({ referringDomains: RD, backlinks: BL });
    await request(app(store, f)).post("/orgs/backlinks/checks").set(H).send(checkBody());
    expect(store.kept.map((k) => k.referringDomain)).not.toContain("oldfriend.com");
  });

  it("the same idempotency key answers the completed check again: no spend, no second Unit", async () => {
    const f1 = fleet({ referringDomains: RD, backlinks: BL });
    const first = await request(app(store, f1)).post("/orgs/backlinks/checks").set(H).send(checkBody());
    const f2 = fleet({ referringDomains: RD, backlinks: BL });
    const again = await request(app(store, f2)).post("/orgs/backlinks/checks").set(H).send(checkBody());
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(f2.calls).toHaveLength(0);
  });

  it("a link already kept is never declared twice; the next check reuses the first window and counts what appeared since", async () => {
    await request(app(store, fleet({ referringDomains: RD, backlinks: BL }))).post("/orgs/backlinks/checks").set(H).send(checkBody("day-1"));
    const f = fleet({ referringDomains: RD, backlinks: BL });
    const res = await request(app(store, f)).post("/orgs/backlinks/checks").set(H).send({ ...checkBody("day-2"), windowDays: 5 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("nothing_new");
    expect(res.body.firstCheck).toBe(false);
    expect(res.body.windowStart).toBe("2026-09-10T12:00:00.000Z");
    expect(res.body.unitsDeclared).toBe(0);
    expect(outcomeCalls(f)).toHaveLength(0);
    // nothing new at domain level: one provider call only
    expect(tregCalls(f)).toHaveLength(1);
    expect(store.kept).toHaveLength(2);
  });

  it("a candidate whose page does not hold the link is not kept and is retried next time", async () => {
    const f = fleet({ referringDomains: RD, backlinks: BL });
    const res = await request(app(store, f, { verify: (u) => (u.includes("sota2") ? "not_linking" : "verified") }))
      .post("/orgs/backlinks/checks").set(H).send(checkBody());
    expect(res.body.newLinks.map((l: any) => l.referringDomain)).toEqual(["goalsetting.co"]);
    expect(res.body.rejected).toEqual([{ referringDomain: "sota2.com", referringUrl: "https://blog.sota2.com/p", verification: "not_linking" }]);
    const next = await request(app(store, fleet({ referringDomains: RD, backlinks: BL }))).post("/orgs/backlinks/checks").set(H).send(checkBody("k2"));
    expect(next.body.newLinks.map((l: any) => l.referringDomain)).toEqual(["sota2.com"]);
  });

  it("a Unit that could not be declared is a 502, the link stays kept, and the next check declares it once", async () => {
    const bad = fleet({ referringDomains: RD, backlinks: BL, outcomesStatus: 503 });
    const res = await request(app(store, bad)).post("/orgs/backlinks/checks").set(H).send(checkBody("k1"));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("outcome_declaration_failed");
    expect(store.kept.every((k) => k.declaredRunId === null)).toBe(true);

    const f = fleet({ referringDomains: RD, backlinks: BL });
    const next = await request(app(store, f)).post("/orgs/backlinks/checks").set(H).send(checkBody("k2"));
    expect(next.body.status).toBe("nothing_new");
    expect(next.body.unitsDeclared).toBe(2);
    expect(outcomeCalls(f)[0].body.produced).toHaveLength(2);
    const third = fleet({ referringDomains: RD, backlinks: BL });
    await request(app(store, third)).post("/orgs/backlinks/checks").set(H).send(checkBody("k3"));
    expect(outcomeCalls(third)).toHaveLength(0);
  });

  it("refuses a different outcome, with no spend", async () => {
    const f = fleet({ referringDomains: RD, backlinks: BL });
    const res = await request(app(store, f)).post("/orgs/backlinks/checks").set(H).send({ ...checkBody(), outcomeKey: "company_researched" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("wrong_outcome");
    expect(f.calls).toHaveLength(0);
  });

  it("named refusals: no brand, brand without site, provider down, credit refused", async () => {
    const f = fleet({ referringDomains: RD, backlinks: BL });
    const { "x-brand-id": _b, ...noBrand } = H;
    expect((await request(app(store, f)).post("/orgs/backlinks/checks").set(noBrand).send(checkBody())).body.error).toBe("brand_required");

    const noSite = await request(app(store, f, { site: null })).post("/orgs/backlinks/checks").set(H).send(checkBody("a"));
    expect([noSite.status, noSite.body.error]).toEqual([422, "brand_has_no_site"]);

    const down = fleet({ tregStatus: 503 });
    const r1 = await request(app(store, down)).post("/orgs/backlinks/checks").set(H).send(checkBody("b"));
    expect([r1.status, r1.body.error]).toEqual([502, "provider_unavailable"]);
    expect(down.costs.filter((c) => c.item.status === "provisioned").every((c) => c.status === "cancelled")).toBe(true);

    const broke = fleet({ referringDomains: RD, sufficient: false });
    const r2 = await request(app(store, broke)).post("/orgs/backlinks/checks").set(H).send(checkBody("c"));
    expect([r2.status, r2.body.error]).toEqual([402, "insufficient_credit"]);
    expect(tregCalls(broke)).toHaveLength(0);
  });

  it("an org key skips the balance authorization but still declares the spend", async () => {
    const f = fleet({ referringDomains: RD, backlinks: BL, keySource: "org" });
    const res = await request(app(store, f)).post("/orgs/backlinks/checks").set(H).send(checkBody());
    expect(res.status).toBe(200);
    expect(f.calls.filter((c) => c.url.includes("authorize"))).toHaveLength(0);
    expect(f.costs.filter((c) => c.item.status === undefined).every((c) => c.item.costSource === "org")).toBe(true);
  });
});

describe("GET /orgs/backlinks", () => {
  it("reads back the brand's kept links", async () => {
    const store = memoryStore();
    await request(app(store, fleet({ referringDomains: RD, backlinks: BL }))).post("/orgs/backlinks/checks").set(H).send(checkBody());
    const res = await request(app(store, fleet({}))).get("/orgs/backlinks").set(H);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.links[0]).toMatchObject({ referringDomain: "goalsetting.co", referringUrl: "https://goalsetting.co/qa/x", domainRank: 35, unitDeclared: true });
  });
});

describe("POST /orgs/backlinks/link-gaps", () => {
  const GAP = [
    { domain_intersection: { "1": { target: "hubspot.com", rank: 246, backlinks_spam_score: 3 }, "2": { target: "hubspot.com", rank: 240, backlinks_spam_score: 2 } } },
    { domain_intersection: { "1": { target: "spammy.biz", rank: 300, backlinks_spam_score: 40 }, "3": { target: "spammy.biz", rank: 300, backlinks_spam_score: 40 } } },
    { domain_intersection: { "2": { target: "solo.com", rank: 500, backlinks_spam_score: 0 } } },
    { domain_intersection: { "1": { target: "weak.com", rank: 10, backlinks_spam_score: 0 }, "2": { target: "weak.com", rank: 10, backlinks_spam_score: 0 } } },
  ];
  const body = { idempotencyKey: "2026-11-09", competitors: ["https://www.martal.ca", "belkins.io", "gojiberry.ai"], minCompetitors: 2, minDomainRank: 100, maxSpamScore: 5 };

  it("keeps strong low-spam sources linking to several competitors, declares no Unit, meters on the caller's run, replays", async () => {
    const store = memoryStore();
    const f = fleet({ gap: GAP });
    const res = await request(app(store, f)).post("/orgs/backlinks/link-gaps").set(H).send(body);
    expect(res.status).toBe(200);
    expect(res.body.competitors).toEqual(["belkins.io", "gojiberry.ai", "martal.ca"]);
    expect(res.body.sources).toEqual([{ domain: "hubspot.com", domainRank: 246, spamScore: 3, competitorCount: 2, competitors: ["belkins.io", "gojiberry.ai"] }]);
    expect(tregCalls(f)[0].body[0].exclude_targets).toEqual(["distribute.you"]);
    expect(outcomeCalls(f)).toHaveLength(0);
    expect(f.costs.every((c) => c.runId === RUN)).toBe(true);
    expect(res.body.costMicroUsd).toBe(24_000 + 36 * 4);

    const f2 = fleet({ gap: GAP });
    const again = await request(app(store, f2)).post("/orgs/backlinks/link-gaps").set(H).send({ ...body, competitors: ["gojiberry.ai", "martal.ca", "belkins.io"] });
    expect(again.body).toEqual({ ...res.body, replayed: true });
    expect(f2.calls).toHaveLength(0);
  });

  it("refuses minCompetitors above the competitors stated", async () => {
    const res = await request(app(memoryStore(), fleet({ gap: GAP }))).post("/orgs/backlinks/link-gaps").set(H).send({ ...body, minCompetitors: 4 });
    expect([res.status, res.body.error]).toEqual([400, "invalid_competitors"]);
  });
});

describe("link verification", () => {
  it("finds an anchor to the brand or a subdomain, ignores mentions and look-alikes", () => {
    expect(htmlLinksTo('<p><a class="x" href="https://www.distribute.you/blog">x</a></p>', "distribute.you")).toBe(true);
    expect(htmlLinksTo("<a href='//app.distribute.you'>x</a>", "distribute.you")).toBe(true);
    expect(htmlLinksTo("<a href=https://distribute.you>x</a>", "distribute.you")).toBe(true);
    expect(htmlLinksTo("<p>distribute.you is great</p>", "distribute.you")).toBe(false);
    expect(htmlLinksTo('<a href="https://notdistribute.you/">x</a>', "distribute.you")).toBe(false);
    expect(htmlLinksTo('<a href="https://x.com/?u=https://distribute.you">x</a>', "distribute.you")).toBe(false);
  });

  it("matches a referring host to the domain the provider dated new", () => {
    expect(matchNewDomain("blog.sota2.com", ["sota2.com"])).toBe("sota2.com");
    expect(matchNewDomain("sota2.com", ["blog.sota2.com"])).toBe("blog.sota2.com");
    expect(matchNewDomain("oldfriend.com", ["sota2.com"])).toBeNull();
  });
});

describe("verifyLink: a domain forwarding to the brand's own site is never a backlink", () => {
  const page = (url: string, html: string) =>
    (async () => ({ ok: true, status: 200, url, text: async () => html }) as unknown as Response);
  const brandNav = '<nav><a href="https://distribute.you/pricing">Pricing</a></nav>';

  it("a referring URL that redirects onto the brand's site is rejected, though the landed page links to the brand", async () => {
    // leaddistribute.com -> https://distribute.you/ (the brand's own sending domain forwarding home)
    expect(await verifyLink("https://leaddistribute.com/", "distribute.you", page("https://distribute.you/", brandNav))).toBe("redirects_to_brand");
    expect(await verifyLink("https://x.com/", "distribute.you", page("https://app.distribute.you/login", brandNav))).toBe("redirects_to_brand");
  });

  it("a third-party page holding the link is still verified, a redirect to another third party too", async () => {
    expect(await verifyLink("https://blog.sota2.com/p", "distribute.you", page("https://blog.sota2.com/p", brandNav))).toBe("verified");
    expect(await verifyLink("http://sota2.com/p", "distribute.you", page("https://www.sota2.com/p", brandNav))).toBe("verified");
    expect(await verifyLink("https://notdistribute.you/", "distribute.you", page("https://notdistribute.you/", "<p>hi</p>"))).toBe("not_linking");
  });
});
