/**
 * Backlink Engine doors (BACKLINK-ENGINE-1109).
 *
 * CHECK: for the run's brand, read the domains that started linking to the brand's site
 * since the brand's window start, verify each candidate link is LIVE now on its referring
 * page, keep every verified link NEW for the brand (one referring domain = one earned link
 * per org × brand, ever) and declare one `backlink_earned` Unit per kept link on the
 * caller's run (subject = the kept link, subjectService "scraping-service"). The treg
 * spend is held + actualized on that same run (treg-meter.ts).
 *  - Window: the brand's FIRST check sets windowStart = now - windowDays; every later check
 *    of that org × brand reuses it, so the first check never counts the brand's whole
 *    history and the next ones count what appeared since (already-kept domains excluded).
 *  - "New" is domain-level: a referring domain counts only when the provider dates its
 *    FIRST link to the brand inside the window (a domain that already linked before is
 *    never a new earned link because it added a page).
 *  - Idempotent per (org, brand, idempotencyKey): a completed check answers again with no
 *    spend; a failed one runs again; a running one is a 409.
 *  - A kept link whose Unit could not be declared stays kept with no declaration; the
 *    brand's next check declares it (on that check's run), so a Unit is never lost nor
 *    declared twice.
 *
 * LINK GAP: domains linking to at least `minCompetitors` of the stated competitors but not
 * to the brand, filtered on authority and spam. Same metering, NO Unit (outreach material).
 */

import { BacklinkError, TregMeter, identityHeaders, type FetchLike, type MeterIdentity } from "./treg-meter.js";
import {
  backlinksSince,
  linkGap,
  newReferringDomains,
  type BacklinkProvider,
  type ProviderBacklink,
} from "./backlink-provider.js";
import { verifyLink, mapLimit, type Verification } from "./link-verify.js";
import { errorMessage } from "./db-error.js";

export const BACKLINK_OUTCOME_KEY = "backlink_earned";
export const SUBJECT_SERVICE = "scraping-service";
const VERIFY_CONCURRENCY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- store (drizzle in prod, in-memory in tests) ----------

export interface CheckRow {
  id: string;
  orgId: string;
  brandId: string;
  idempotencyKey: string;
  runId: string;
  status: "running" | "completed" | "failed";
  windowStart: Date | null;
  answer: CheckAnswer | null;
}

export interface KeptLinkRow {
  id: string;
  referringDomain: string;
  referringUrl: string;
  targetUrl: string;
  anchor: string | null;
  dofollow: boolean | null;
  domainRank: number | null;
  spamScore: number | null;
  firstSeenAt: Date | null;
  provider: string;
  verifiedAt: Date;
  checkId: string;
  declaredRunId: string | null;
  declaredAt: Date | null;
  createdAt: Date;
}

export type NewKeptLink = Omit<KeptLinkRow, "id" | "declaredRunId" | "declaredAt" | "createdAt">;

export interface GapRow {
  id: string;
  status: "running" | "completed" | "failed";
  answer: LinkGapAnswer | null;
}

export interface BacklinkStore {
  findCheck(orgId: string, brandId: string, idempotencyKey: string): Promise<CheckRow | null>;
  /** Inserts a running check; null when a row with that key already exists (race). */
  insertCheck(row: { orgId: string; brandId: string; idempotencyKey: string; runId: string; campaignId: string | null; provider: string; brandDomain: string; windowStart: Date }): Promise<CheckRow | null>;
  /** A failed check runs again under a new run. */
  restartCheck(id: string, runId: string, brandDomain: string, windowStart: Date): Promise<void>;
  /** The brand's window start: the one its first check set (null = no check yet). */
  windowStart(orgId: string, brandId: string): Promise<Date | null>;
  completeCheck(id: string, answer: CheckAnswer): Promise<void>;
  failCheck(id: string, errorCode: string): Promise<void>;
  keptDomains(orgId: string, brandId: string): Promise<Set<string>>;
  /** Inserts the links; returns only the rows written (a domain already kept is skipped). */
  insertKept(orgId: string, brandId: string, rows: NewKeptLink[]): Promise<KeptLinkRow[]>;
  undeclared(orgId: string, brandId: string): Promise<KeptLinkRow[]>;
  markDeclared(ids: string[], runId: string): Promise<void>;
  listKept(orgId: string, brandId: string): Promise<KeptLinkRow[]>;
  findGap(orgId: string, brandId: string, idempotencyKey: string, competitorsKey: string): Promise<GapRow | null>;
  insertGap(row: { orgId: string; brandId: string; idempotencyKey: string; competitorsKey: string; runId: string; provider: string }): Promise<GapRow | null>;
  restartGap(id: string, runId: string): Promise<void>;
  completeGap(id: string, answer: LinkGapAnswer): Promise<void>;
  failGap(id: string, errorCode: string): Promise<void>;
}

// ---------- wire shapes ----------

export interface WireLink {
  id: string;
  referringDomain: string;
  referringUrl: string;
  targetUrl: string;
  anchor: string | null;
  dofollow: boolean | null;
  domainRank: number | null;
  spamScore: number | null;
  firstSeenAt: string | null;
  verifiedAt: string;
  provider: string;
  unitDeclared: boolean;
  declaredRunId: string | null;
}

export interface CheckAnswer {
  checkId: string;
  status: "new_links_kept" | "nothing_new";
  brandId: string;
  brandDomain: string;
  provider: BacklinkProvider;
  outcomeKey: typeof BACKLINK_OUTCOME_KEY;
  firstCheck: boolean;
  windowStart: string;
  runId: string;
  newLinks: WireLink[];
  unitsDeclared: number;
  candidatesCount: number;
  rejected: Array<{ referringDomain: string; referringUrl: string; verification: Exclude<Verification, "verified"> }>;
  newReferringDomainsCount: number;
  truncated: boolean;
  costMicroUsd: number;
  providerCalls: number;
  checkedAt: string;
  replayed: boolean;
}

export interface LinkGapAnswer {
  reportId: string;
  brandId: string;
  brandDomain: string;
  provider: BacklinkProvider;
  competitors: string[];
  minCompetitors: number;
  minDomainRank: number;
  maxSpamScore: number;
  sources: Array<{ domain: string; domainRank: number | null; spamScore: number | null; competitorCount: number; competitors: string[] }>;
  scannedCount: number;
  truncated: boolean;
  runId: string;
  costMicroUsd: number;
  providerCalls: number;
  reportedAt: string;
  replayed: boolean;
}

export function wireLink(r: KeptLinkRow): WireLink {
  return {
    id: r.id,
    referringDomain: r.referringDomain,
    referringUrl: r.referringUrl,
    targetUrl: r.targetUrl,
    anchor: r.anchor,
    dofollow: r.dofollow,
    domainRank: r.domainRank,
    spamScore: r.spamScore,
    firstSeenAt: r.firstSeenAt ? r.firstSeenAt.toISOString() : null,
    verifiedAt: r.verifiedAt.toISOString(),
    provider: r.provider,
    unitDeclared: r.declaredRunId !== null,
    declaredRunId: r.declaredRunId,
  };
}

// ---------- outcome declaration (synchronous: a Unit we cannot declare is a 502) ----------

export async function declareBacklinkUnits(
  identity: MeterIdentity,
  linkIds: string[],
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const url = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !key) throw new BacklinkError("service_misconfigured", 502, "RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY not set");
  for (let i = 0; i < linkIds.length; i += 1000) {
    const chunk = linkIds.slice(i, i + 1000);
    let res: Response;
    try {
      res = await fetchImpl(`${url}/v1/runs/${identity.runId}/outcomes`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", "X-API-Key": key, "x-service-name": SUBJECT_SERVICE, ...identityHeaders(identity) },
        body: JSON.stringify({
          produced: chunk.map((id) => ({ outcomeKey: BACKLINK_OUTCOME_KEY, subjectService: SUBJECT_SERVICE, subjectId: id })),
          consumed: [],
        }),
      });
    } catch (err) {
      throw new BacklinkError("outcome_declaration_failed", 502, `runs-service unreachable: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new BacklinkError("outcome_declaration_failed", 502, `runs-service declared no Unit: ${res.status} ${text.slice(0, 300)}`);
    }
  }
}

// ---------- check ----------

export interface CheckInput {
  identity: MeterIdentity;
  brandId: string;
  outcomeKey: string;
  idempotencyKey: string;
  windowDays: number;
  provider: BacklinkProvider;
}

export interface Deps {
  store: BacklinkStore;
  brandDomain: (brandId: string) => Promise<string>;
  fetchImpl?: FetchLike;
  verify?: (referringUrl: string, brandDomain: string) => Promise<Verification>;
  now?: () => Date;
}

/** Does the provider's referring host belong to a referring domain the provider dated new? */
export function matchNewDomain(host: string, newDomains: string[]): string | null {
  for (const d of newDomains) {
    if (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) return d;
  }
  return null;
}

export function assertOutcome(outcomeKey: string): void {
  if (outcomeKey !== BACKLINK_OUTCOME_KEY) {
    throw new BacklinkError("wrong_outcome", 400, `this door makes "${BACKLINK_OUTCOME_KEY}" only, not "${outcomeKey}"`, {
      accepted: [BACKLINK_OUTCOME_KEY],
    });
  }
}

export async function runBacklinkCheck(input: CheckInput, deps: Deps): Promise<CheckAnswer> {
  assertOutcome(input.outcomeKey);
  const { store } = deps;
  const { identity, brandId } = input;
  const now = (deps.now ?? (() => new Date()))();

  const existing = await store.findCheck(identity.orgId, brandId, input.idempotencyKey);
  if (existing?.status === "completed" && existing.answer) return { ...existing.answer, replayed: true };
  if (existing?.status === "running") {
    throw new BacklinkError("check_in_progress", 409, `check ${existing.id} for this idempotency key is still running`);
  }

  const brandDomain = await deps.brandDomain(brandId);
  const anchor = await store.windowStart(identity.orgId, brandId);
  const firstCheck = anchor === null;
  const windowStart = anchor ?? new Date(now.getTime() - input.windowDays * DAY_MS);

  let checkId: string;
  if (existing) {
    await store.restartCheck(existing.id, identity.runId, brandDomain, windowStart);
    checkId = existing.id;
  } else {
    const inserted = await store.insertCheck({
      orgId: identity.orgId,
      brandId,
      idempotencyKey: input.idempotencyKey,
      runId: identity.runId,
      campaignId: identity.campaignId ?? null,
      provider: input.provider,
      brandDomain,
      windowStart,
    });
    if (!inserted) throw new BacklinkError("check_in_progress", 409, "a check with this idempotency key was just started");
    checkId = inserted.id;
  }

  const meter = new TregMeter(identity, "/orgs/backlinks/checks", deps.fetchImpl);
  try {
    const kept = await store.keptDomains(identity.orgId, brandId);
    const rd = await newReferringDomains(meter, input.provider, brandDomain, windowStart);
    const newDomains = rd.items.map((d) => d.domain).filter((d) => !kept.has(d));
    const rankOf = new Map(rd.items.map((d) => [d.domain, d]));

    const candidates: Array<ProviderBacklink & { keyDomain: string }> = [];
    let truncated = rd.totalCount > rd.items.length;
    if (newDomains.length > 0) {
      const bl = await backlinksSince(meter, input.provider, brandDomain, windowStart);
      truncated = truncated || bl.totalCount > bl.items.length;
      const seen = new Set<string>();
      for (const b of bl.items) {
        const keyDomain = matchNewDomain(b.referringDomain, newDomains);
        if (!keyDomain || seen.has(keyDomain)) continue;
        seen.add(keyDomain);
        candidates.push({ ...b, keyDomain });
      }
    }

    const verify = deps.verify ?? ((u: string, d: string) => verifyLink(u, d));
    const verdicts = await mapLimit(candidates, VERIFY_CONCURRENCY, (c) => verify(c.referringUrl, brandDomain));
    const verifiedAt = new Date();
    const toKeep: NewKeptLink[] = [];
    const rejected: CheckAnswer["rejected"] = [];
    candidates.forEach((c, i) => {
      const v = verdicts[i];
      if (v !== "verified") {
        rejected.push({ referringDomain: c.keyDomain, referringUrl: c.referringUrl, verification: v });
        return;
      }
      const dom = rankOf.get(c.keyDomain);
      toKeep.push({
        referringDomain: c.keyDomain,
        referringUrl: c.referringUrl,
        targetUrl: c.targetUrl,
        anchor: c.anchor,
        dofollow: c.dofollow,
        domainRank: c.domainRank ?? dom?.domainRank ?? null,
        spamScore: c.spamScore ?? dom?.spamScore ?? null,
        firstSeenAt: dom?.firstSeenAt ? new Date(dom.firstSeenAt) : c.firstSeenAt ? new Date(c.firstSeenAt) : null,
        provider: input.provider,
        verifiedAt,
        checkId,
      });
    });
    const inserted = toKeep.length ? await store.insertKept(identity.orgId, brandId, toKeep) : [];

    // Declare every kept link of the brand with no Unit yet (this check's + any left over).
    const pending = await store.undeclared(identity.orgId, brandId);
    if (pending.length) {
      await declareBacklinkUnits(identity, pending.map((p) => p.id), deps.fetchImpl);
      await store.markDeclared(pending.map((p) => p.id), identity.runId);
    }
    const declaredIds = new Set(pending.map((p) => p.id));
    const newLinks = inserted.map((r) =>
      wireLink(declaredIds.has(r.id) ? { ...r, declaredRunId: identity.runId, declaredAt: new Date() } : r)
    );

    const answer: CheckAnswer = {
      checkId,
      status: newLinks.length ? "new_links_kept" : "nothing_new",
      brandId,
      brandDomain,
      provider: input.provider,
      outcomeKey: BACKLINK_OUTCOME_KEY,
      firstCheck,
      windowStart: windowStart.toISOString(),
      runId: identity.runId,
      newLinks,
      unitsDeclared: pending.length,
      candidatesCount: candidates.length,
      rejected,
      newReferringDomainsCount: newDomains.length,
      truncated,
      costMicroUsd: meter.chargedMicro,
      providerCalls: meter.calls,
      checkedAt: verifiedAt.toISOString(),
      replayed: false,
    };
    await store.completeCheck(checkId, answer);
    return answer;
  } catch (err) {
    const code = err instanceof BacklinkError ? err.code : "internal_error";
    await store.failCheck(checkId, code).catch((e) => console.error(`[scraping-service] backlink check ${checkId} not marked failed:`, e));
    throw err;
  }
}

// ---------- link gap ----------

export interface GapInput {
  identity: MeterIdentity;
  brandId: string;
  idempotencyKey: string;
  competitors: string[];
  minCompetitors: number;
  minDomainRank: number;
  maxSpamScore: number;
  provider: BacklinkProvider;
}

export async function runLinkGap(input: GapInput, deps: Deps): Promise<LinkGapAnswer> {
  const { store } = deps;
  const { identity, brandId } = input;
  const brandDomain = await deps.brandDomain(brandId);
  const competitors = [...new Set(input.competitors)].filter((c) => c !== brandDomain).sort();
  if (competitors.length < 1) throw new BacklinkError("invalid_competitors", 400, "state at least one competitor domain other than the brand's own");
  if (input.minCompetitors > competitors.length) {
    throw new BacklinkError("invalid_competitors", 400, `minCompetitors ${input.minCompetitors} exceeds the ${competitors.length} distinct competitors stated`);
  }
  const competitorsKey = competitors.join(",");

  const existing = await store.findGap(identity.orgId, brandId, input.idempotencyKey, competitorsKey);
  if (existing?.status === "completed" && existing.answer) return { ...existing.answer, replayed: true };
  if (existing?.status === "running") throw new BacklinkError("check_in_progress", 409, `link gap ${existing.id} for this key is still running`);

  let reportId: string;
  if (existing) {
    await store.restartGap(existing.id, identity.runId);
    reportId = existing.id;
  } else {
    const inserted = await store.insertGap({ orgId: identity.orgId, brandId, idempotencyKey: input.idempotencyKey, competitorsKey, runId: identity.runId, provider: input.provider });
    if (!inserted) throw new BacklinkError("check_in_progress", 409, "a link gap with this key was just started");
    reportId = inserted.id;
  }

  const meter = new TregMeter(identity, "/orgs/backlinks/link-gaps", deps.fetchImpl);
  try {
    const page = await linkGap(meter, input.provider, brandDomain, competitors);
    const sources = page.items
      .filter((s) => s.competitors.length >= input.minCompetitors)
      .filter((s) => (input.minDomainRank <= 0 ? true : s.domainRank !== null && s.domainRank >= input.minDomainRank))
      .filter((s) => s.spamScore === null || s.spamScore <= input.maxSpamScore)
      .filter((s) => s.domain !== brandDomain && !s.domain.endsWith(`.${brandDomain}`))
      .map((s) => ({ domain: s.domain, domainRank: s.domainRank, spamScore: s.spamScore, competitorCount: s.competitors.length, competitors: s.competitors }))
      .sort((a, b) => b.competitorCount - a.competitorCount || (b.domainRank ?? -1) - (a.domainRank ?? -1));
    const answer: LinkGapAnswer = {
      reportId,
      brandId,
      brandDomain,
      provider: input.provider,
      competitors,
      minCompetitors: input.minCompetitors,
      minDomainRank: input.minDomainRank,
      maxSpamScore: input.maxSpamScore,
      sources,
      scannedCount: page.items.length,
      truncated: page.totalCount > page.items.length,
      runId: identity.runId,
      costMicroUsd: meter.chargedMicro,
      providerCalls: meter.calls,
      reportedAt: new Date().toISOString(),
      replayed: false,
    };
    await store.completeGap(reportId, answer);
    return answer;
  } catch (err) {
    const code = err instanceof BacklinkError ? err.code : "internal_error";
    await store.failGap(reportId, code).catch((e) => console.error(`[scraping-service] link gap ${reportId} not marked failed:`, e));
    throw err;
  }
}
