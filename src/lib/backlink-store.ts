import { and, asc, eq, isNull, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { backlinkChecks, brandBacklinks, linkGapReports } from "../db/schema.js";
import type { BacklinkStore, CheckAnswer, CheckRow, GapRow, KeptLinkRow, LinkGapAnswer } from "./backlinks.js";

const toCheck = (r: typeof backlinkChecks.$inferSelect): CheckRow => ({
  id: r.id,
  orgId: r.orgId,
  brandId: r.brandId,
  idempotencyKey: r.idempotencyKey,
  runId: r.runId,
  status: r.status as CheckRow["status"],
  windowStart: r.windowStart,
  answer: (r.answer as CheckAnswer | null) ?? null,
});

const toGap = (r: typeof linkGapReports.$inferSelect): GapRow => ({
  id: r.id,
  status: r.status as GapRow["status"],
  answer: (r.answer as LinkGapAnswer | null) ?? null,
});

const toKept = (r: typeof brandBacklinks.$inferSelect): KeptLinkRow => ({
  id: r.id,
  referringDomain: r.referringDomain,
  referringUrl: r.referringUrl,
  targetUrl: r.targetUrl,
  anchor: r.anchor,
  dofollow: r.dofollow,
  domainRank: r.domainRank,
  spamScore: r.spamScore,
  firstSeenAt: r.firstSeenAt,
  provider: r.provider,
  verifiedAt: r.verifiedAt,
  checkId: r.checkId,
  declaredRunId: r.declaredRunId,
  declaredAt: r.declaredAt,
  createdAt: r.createdAt,
});

/** Postgres-backed store; every query is scoped by org_id (tenant isolation). */
export const drizzleBacklinkStore: BacklinkStore = {
  async findCheck(orgId, brandId, idempotencyKey) {
    const [r] = await db.select().from(backlinkChecks).where(and(eq(backlinkChecks.orgId, orgId), eq(backlinkChecks.brandId, brandId), eq(backlinkChecks.idempotencyKey, idempotencyKey))).limit(1);
    return r ? toCheck(r) : null;
  },
  async insertCheck(row) {
    const [r] = await db.insert(backlinkChecks).values({ ...row, status: "running" }).onConflictDoNothing().returning();
    return r ? toCheck(r) : null;
  },
  async restartCheck(id, runId, brandDomain, windowStart) {
    await db.update(backlinkChecks).set({ status: "running", runId, brandDomain, windowStart, errorCode: null, completedAt: null }).where(eq(backlinkChecks.id, id));
  },
  async windowStart(orgId, brandId) {
    const [r] = await db
      .select({ windowStart: backlinkChecks.windowStart })
      .from(backlinkChecks)
      .where(and(eq(backlinkChecks.orgId, orgId), eq(backlinkChecks.brandId, brandId)))
      .orderBy(asc(backlinkChecks.createdAt))
      .limit(1);
    return r?.windowStart ?? null;
  },
  async completeCheck(id, answer) {
    await db.update(backlinkChecks).set({ status: "completed", answer, completedAt: new Date() }).where(eq(backlinkChecks.id, id));
  },
  async failCheck(id, errorCode) {
    await db.update(backlinkChecks).set({ status: "failed", errorCode, completedAt: new Date() }).where(eq(backlinkChecks.id, id));
  },
  async keptDomains(orgId, brandId) {
    const rows = await db.select({ d: brandBacklinks.referringDomain }).from(brandBacklinks).where(and(eq(brandBacklinks.orgId, orgId), eq(brandBacklinks.brandId, brandId)));
    return new Set(rows.map((r) => r.d));
  },
  async insertKept(orgId, brandId, rows) {
    if (!rows.length) return [];
    const inserted = await db
      .insert(brandBacklinks)
      .values(rows.map((r) => ({ ...r, orgId, brandId })))
      .onConflictDoNothing()
      .returning();
    return inserted.map(toKept);
  },
  async undeclared(orgId, brandId) {
    const rows = await db.select().from(brandBacklinks).where(and(eq(brandBacklinks.orgId, orgId), eq(brandBacklinks.brandId, brandId), isNull(brandBacklinks.declaredRunId)));
    return rows.map(toKept);
  },
  async markDeclared(ids, runId) {
    if (!ids.length) return;
    await db.update(brandBacklinks).set({ declaredRunId: runId, declaredAt: new Date() }).where(inArray(brandBacklinks.id, ids));
  },
  async listKept(orgId, brandId) {
    const rows = await db.select().from(brandBacklinks).where(and(eq(brandBacklinks.orgId, orgId), eq(brandBacklinks.brandId, brandId))).orderBy(asc(brandBacklinks.createdAt));
    return rows.map(toKept);
  },
  async findGap(orgId, brandId, idempotencyKey, competitorsKey) {
    const [r] = await db
      .select()
      .from(linkGapReports)
      .where(and(eq(linkGapReports.orgId, orgId), eq(linkGapReports.brandId, brandId), eq(linkGapReports.idempotencyKey, idempotencyKey), eq(linkGapReports.competitorsKey, competitorsKey)))
      .limit(1);
    return r ? toGap(r) : null;
  },
  async insertGap(row) {
    const [r] = await db.insert(linkGapReports).values({ ...row, status: "running" }).onConflictDoNothing().returning();
    return r ? toGap(r) : null;
  },
  async restartGap(id, runId) {
    await db.update(linkGapReports).set({ status: "running", runId, errorCode: null, completedAt: null }).where(eq(linkGapReports.id, id));
  },
  async completeGap(id, answer) {
    await db.update(linkGapReports).set({ status: "completed", answer, completedAt: new Date() }).where(eq(linkGapReports.id, id));
  },
  async failGap(id, errorCode) {
    await db.update(linkGapReports).set({ status: "failed", errorCode, completedAt: new Date() }).where(eq(linkGapReports.id, id));
  },
};
