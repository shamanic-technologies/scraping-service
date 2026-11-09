/**
 * Backlink data providers (BACKLINK-ENGINE-1109), read through treg (metered).
 * The caller may state the provider as a tactic from BACKLINK_PROVIDERS; absent =
 * the first one. Each provider answers the same three questions:
 *  - newReferringDomains: domains whose FIRST link to the target appeared since a date
 *  - backlinksSince: one live backlink per referring domain, first seen since a date
 *  - linkGap: domains linking to several competitors but not to the target
 */

import { BacklinkError, type TregMeter } from "./treg-meter.js";

export const BACKLINK_PROVIDERS = ["dataforseo"] as const;
export type BacklinkProvider = (typeof BACKLINK_PROVIDERS)[number];

/** DataForSEO bills $0.024 per request + $0.000036 per returned row (treg catalogue, 2026-11-09). */
export const MAX_ROWS = 1000;
const MAX_CALL_MICRO = 24_000 + 36 * MAX_ROWS + 10_000; // 70,000 µ$ = $0.07 ceiling per call

export interface ReferringDomain {
  domain: string;
  firstSeenAt: string | null;
  domainRank: number | null;
  spamScore: number | null;
}

export interface ProviderBacklink {
  referringDomain: string;
  referringUrl: string;
  targetUrl: string;
  anchor: string | null;
  dofollow: boolean | null;
  domainRank: number | null;
  spamScore: number | null;
  firstSeenAt: string | null;
}

export interface GapSource {
  domain: string;
  domainRank: number | null;
  spamScore: number | null;
  competitors: string[];
}

export interface Page<T> {
  items: T[];
  totalCount: number;
}

/** DataForSEO date filter format: "2026-09-10 00:00:00 +00:00". */
export function dataforseoDate(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")} +00:00`;
}

/** "2026-11-08 15:52:40 +00:00" -> ISO, or null. */
export function parseProviderDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw.replace(" ", "T").replace(" +00:00", "Z"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The single task result of a DataForSEO live answer; a task error is a named refusal. */
function dataforseoResult(body: unknown, endpoint: string): Record<string, unknown> {
  const b = body as { status_code?: unknown; status_message?: unknown; tasks?: Array<Record<string, unknown>> } | null;
  const task = b?.tasks?.[0];
  if (!b || b.status_code !== 20000 || !task) {
    throw new BacklinkError("provider_unavailable", 502, `dataforseo ${endpoint}: ${String(b?.status_message ?? "no answer")}`);
  }
  if (task.status_code !== 20000) {
    throw new BacklinkError("provider_unavailable", 502, `dataforseo ${endpoint} task: ${task.status_code} ${String(task.status_message)}`);
  }
  const result = (task.result as Array<Record<string, unknown>> | null)?.[0];
  return result ?? { items: [], total_count: 0 };
}

export function stripWww(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

export async function newReferringDomains(meter: TregMeter, provider: BacklinkProvider, target: string, since: Date): Promise<Page<ReferringDomain>> {
  void provider;
  const endpoint = "dataforseo.web.linking_domains.list";
  const answer = await meter.call(endpoint, {
    maxMicro: MAX_CALL_MICRO,
    body: [
      {
        target,
        backlinks_status_type: "live",
        filters: ["first_seen", ">=", dataforseoDate(since)],
        order_by: ["first_seen,desc"],
        limit: MAX_ROWS,
      },
    ],
  });
  const r = dataforseoResult(answer.body, endpoint);
  const items = ((r.items as Array<Record<string, unknown>> | null) ?? [])
    .map((i) => ({
      domain: stripWww(String(i.domain ?? "")),
      firstSeenAt: parseProviderDate(i.first_seen),
      domainRank: num(i.rank),
      spamScore: num(i.backlinks_spam_score),
    }))
    .filter((i) => i.domain);
  return { items, totalCount: num(r.total_count) ?? items.length };
}

export async function backlinksSince(meter: TregMeter, provider: BacklinkProvider, target: string, since: Date): Promise<Page<ProviderBacklink>> {
  void provider;
  const endpoint = "dataforseo.web.backlinks.list";
  const answer = await meter.call(endpoint, {
    maxMicro: MAX_CALL_MICRO,
    body: [
      {
        target,
        backlinks_status_type: "live",
        mode: "one_per_domain",
        filters: ["first_seen", ">=", dataforseoDate(since)],
        order_by: ["first_seen,desc"],
        limit: MAX_ROWS,
      },
    ],
  });
  const r = dataforseoResult(answer.body, endpoint);
  const items: ProviderBacklink[] = [];
  for (const i of (r.items as Array<Record<string, unknown>> | null) ?? []) {
    const referringUrl = str(i.url_from);
    const domain = str(i.domain_from);
    if (!referringUrl || !domain) continue;
    items.push({
      referringDomain: stripWww(domain),
      referringUrl,
      targetUrl: str(i.url_to) ?? "",
      anchor: str(i.anchor),
      dofollow: typeof i.dofollow === "boolean" ? i.dofollow : null,
      domainRank: num(i.domain_from_rank),
      spamScore: num(i.backlink_spam_score),
      firstSeenAt: parseProviderDate(i.first_seen),
    });
  }
  return { items, totalCount: num(r.total_count) ?? items.length };
}

export async function linkGap(meter: TregMeter, provider: BacklinkProvider, target: string, competitors: string[]): Promise<Page<GapSource>> {
  void provider;
  const endpoint = "dataforseo.x.backlinks-domain-intersection-live";
  const targets = Object.fromEntries(competitors.map((c, i) => [String(i + 1), c]));
  const answer = await meter.call(endpoint, {
    maxMicro: MAX_CALL_MICRO,
    body: [
      {
        targets,
        exclude_targets: [target],
        intersection_mode: "partial",
        backlinks_status_type: "live",
        limit: MAX_ROWS,
      },
    ],
  });
  const r = dataforseoResult(answer.body, endpoint);
  const sources: GapSource[] = [];
  for (const item of (r.items as Array<Record<string, unknown>> | null) ?? []) {
    const inter = (item.domain_intersection ?? {}) as Record<string, Record<string, unknown> | null>;
    let domain: string | null = null;
    let rank: number | null = null;
    let spam: number | null = null;
    const linked: string[] = [];
    for (const [idx, entry] of Object.entries(inter)) {
      if (!entry) continue;
      const comp = targets[idx];
      if (comp) linked.push(comp);
      domain = domain ?? str(entry.target);
      const er = num(entry.rank);
      if (er !== null) rank = rank === null ? er : Math.max(rank, er);
      const es = num(entry.backlinks_spam_score);
      if (es !== null) spam = spam === null ? es : Math.max(spam, es);
    }
    if (!domain || linked.length === 0) continue;
    sources.push({ domain: stripWww(domain), domainRank: rank, spamScore: spam, competitors: linked.sort() });
  }
  return { items: sources, totalCount: num(r.total_count) ?? sources.length };
}
