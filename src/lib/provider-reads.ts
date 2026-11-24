/**
 * Provider reads (ENGINE-GET-ASK-1123): what this service already HOLDS for an outcome,
 * listed per calling org. A Script finds each read by its OpenAPI tag `provider:<outcomeKey>`.
 * A read never spends, never opens a run, never makes anything; no Unit = an empty list.
 *
 * - `page_read`: one Unit per completed `scrape_requests` row (a fresh read; a cache hit
 *   creates no row).
 * - `company_researched`: the rows whose caller stated `outcomeKey: "company_researched"`
 *   (stored in `scrape_requests.outcome_key`), with a run and a company domain: exactly what
 *   the scrape's run declared to runs-service.
 *
 * What we keep of a read: the request row forever; the page content (`scrape_results`:
 * markdown, metadata, resolved URL) 7 days, ONE row per normalized URL shared across orgs,
 * then the hourly retention deletes it.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { companyDomainOf } from "./outcome-declaration.js";

export const PAGE_READ_OUTCOME_KEY = "page_read";
export const COMPANY_RESEARCHED_OUTCOME_KEY = "company_researched";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const MAX_LIMIT_WITH_CONTENT = 20;
export const MAX_URLS = 50;
export const MAX_DOMAINS = 100;

// ---------- SQL twins of the JS url keys ----------

/**
 * SQL twin of `companyDomainOf` (src/lib/outcome-declaration.ts). Keep the two in step,
 * line by line (parity pinned by tests/unit/provider-reads.test.ts on the JS side and
 * tests/integration/provider-reads.test.ts against Postgres):
 *
 *   JS                                          SQL
 *   raw.trim().toLowerCase()                    lower(btrim(url, <ascii whitespace>))
 *   .replace(/^[a-z]+:\/\//, "")                regexp_replace(.., '^[a-z]+://', '')
 *   .replace(/^www\./, "")                      regexp_replace(.., '^www[.]', '')
 *   .split(/[/?#]/)[0]                          regexp_replace(.., '[/?#].*$', '')
 *   .replace(/:\d+$/, "")                       regexp_replace(.., ':[0-9]+$', '')
 *   /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)?s:null   substring(.. from '^[a-z0-9.-]+[.][a-z]{2,}$')
 *
 * NULL when the url holds no usable domain, like the JS. Only difference: `trim()` also
 * strips non-ASCII whitespace; a stored url never starts with one (POST /scrape validates it).
 */
export function companyDomainSql(url: AnyColumn | SQL): SQL<string | null> {
  return sql<string | null>`substring(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(btrim(${url}, E' \\t\\n\\r\\f\\v')), '^[a-z]+://', ''), '^www[.]', ''), '[/?#].*$', ''), ':[0-9]+$', '') from '^[a-z0-9.-]+[.][a-z]{2,}$')`;
}

/**
 * The page a url names: host (www. ignored) + path, lowercased, without scheme, port,
 * query string, fragment or ONE trailing slash. Equals `normalizeUrl` (src/lib/firecrawl.ts)
 * on every ordinary http(s) url; written with regexes so Postgres can compute the same key
 * on the stored `scrape_requests.url` (`pageKeySql` below, same steps in the same order).
 */
export function pageKeyOf(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#][\s\S]*$/, "")
    .replace(/^([^/:]*):[0-9]+(\/|$)/, "$1$2")
    .replace(/\/$/, "");
}

/** SQL twin of `pageKeyOf`: same five steps, same order. */
export function pageKeySql(url: AnyColumn | SQL): SQL<string> {
  return sql<string>`regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(btrim(${url}, E' \\t\\n\\r\\f\\v')), '^[a-z][a-z0-9+.-]*://', ''), '^www[.]', ''), '[?#].*$', ''), '^([^/:]*):[0-9]+(/|$)', '\\1\\2'), '/$', '')`;
}

// ---------- cursor ----------

/** Keyset position: the last row of a page, `createdAt` kept at Postgres precision (microseconds). */
export interface ReadCursor {
  ts: string;
  id: string;
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(c: ReadCursor): string {
  return Buffer.from(`${c.ts}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): ReadCursor | null {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [ts, id, ...rest] = text.split("|");
  if (rest.length || !ts || !id || !CURSOR_TS.test(ts) || !UUID.test(id)) return null;
  return { ts, id: id.toLowerCase() };
}

/** `2026-11-20T10:00:00.123Z` -> `2026-11-20T10:00:00.123000Z` (the cursor's fixed-width form). */
export function cursorTsOf(d: Date): string {
  return d.toISOString().replace(/Z$/, "000Z");
}

// ---------- query lists ----------

/** A list query param: comma-separated, repeated, or both. Trimmed, empties dropped, deduplicated. */
export function splitList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(","));
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}

// ---------- store contract ----------

export interface ReadFilter {
  orgId: string;
  kind: typeof PAGE_READ_OUTCOME_KEY | typeof COMPANY_RESEARCHED_OUTCOME_KEY;
  /** page_read: page keys (`pageKeyOf` form) to match exactly. */
  pageKeys?: string[];
  /** page_read: a site domain; matches that host and its subdomains. */
  domain?: string;
  /** company_researched: subject ids (company domains) to match exactly. */
  domains?: string[];
  brandId?: string;
  campaignId?: string;
  /** Completed at or after. */
  since?: Date;
  before?: ReadCursor;
  /** Rows to return (the route asks for one more than the page to know `hasMore`). */
  limit: number;
  withContent: boolean;
}

export interface ReadRow {
  id: string;
  url: string;
  provider: string;
  runId: string | null;
  outcomeKey: string | null;
  brandIds: string[] | null;
  campaignId: string | null;
  workflowSlug: string | null;
  createdAt: Date;
  /** `createdAt` in UTC with microseconds (`...SS.ffffffZ`), the keyset cursor's first half. */
  cursorTs: string;
  completedAt: Date | null;
  /** The stored page content of THIS read, when still held (null = deleted, replaced by a later read, or never stored). */
  resultId: string | null;
  resultExpiresAt: Date | null;
  /** Only read when `withContent`. */
  markdown: string | null;
  metadata: unknown;
  resolvedUrl: string | null;
}

/** Every implementation scopes by `filter.orgId` and orders newest first (created_at desc, id desc). */
export interface ProviderReadStore {
  listReads(filter: ReadFilter): Promise<ReadRow[]>;
}

// ---------- wire shapes ----------

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function ageDays(at: Date, now: Date): number {
  return Math.max(0, Math.round(((now.getTime() - at.getTime()) / 86_400_000) * 10) / 10);
}

function titleOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const t = m.title ?? m.ogTitle;
  return typeof t === "string" && t.trim() ? t : null;
}

function wireContent(r: ReadRow, withContent: boolean) {
  const held = r.resultId !== null;
  const base = { held, resultId: r.resultId, expiresAt: iso(r.resultExpiresAt) };
  if (!withContent || !held) return base;
  return { ...base, markdown: r.markdown, title: titleOf(r.metadata), resolvedUrl: r.resolvedUrl };
}

export function wirePageRead(r: ReadRow, now: Date, withContent: boolean) {
  const readAt = r.completedAt ?? r.createdAt;
  return {
    id: r.id,
    url: r.url,
    domain: companyDomainOf(r.url),
    readAt: readAt.toISOString(),
    ageDays: ageDays(readAt, now),
    runId: r.runId,
    provider: r.provider,
    outcomeKey: r.outcomeKey,
    brandIds: r.brandIds ?? [],
    campaignId: r.campaignId,
    content: wireContent(r, withContent),
  };
}

/** Null when the row names no company domain (the store never returns one; belt and braces). */
export function wireCompanyResearched(r: ReadRow, now: Date) {
  const subjectId = companyDomainOf(r.url);
  if (!subjectId) return null;
  const researchedAt = r.completedAt ?? r.createdAt;
  return {
    id: r.id,
    subject: { subjectService: "lead-service" as const, subjectId },
    url: r.url,
    researchedAt: researchedAt.toISOString(),
    ageDays: ageDays(researchedAt, now),
    runId: r.runId,
    brandIds: r.brandIds ?? [],
    campaignId: r.campaignId,
    workflowSlug: r.workflowSlug,
    content: wireContent(r, false),
  };
}

/** One page out of `limit + 1` fetched rows. */
export function pageOf(rows: ReadRow[], limit: number): { page: ReadRow[]; nextBefore: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { page, hasMore, nextBefore: hasMore && last ? encodeCursor({ ts: last.cursorTs, id: last.id }) : null };
}
