import { describe, it, expect, vi } from "vitest";
import {
  BackfillError,
  declareBatch,
  pastScrapeDeclaration,
  toBatches,
  type BackfillEntry,
} from "../../src/lib/outcome-backfill.js";

const RUN = "6F0C1E7A-1111-4222-8333-944455556666";
const row = (over: Partial<Parameters<typeof pastScrapeDeclaration>[0]> = {}) => ({
  runId: RUN,
  url: "http://www.epsfirm.com/",
  sourceService: "workflow-service",
  workflowSlug: "sales-cold-email-outreach-nimbus",
  status: "completed",
  ...over,
});

const entry = (i: number): BackfillEntry => ({
  runId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  occurredAt: "run_started_at",
  produced: [{ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: `d${i}.com` }],
  consumed: [],
});

describe("pastScrapeDeclaration", () => {
  it("declares company_researched on the prospect's domain, at the run's start", () => {
    expect(pastScrapeDeclaration(row())).toEqual({
      runId: RUN.toLowerCase(),
      occurredAt: "run_started_at",
      produced: [{ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "epsfirm.com" }],
      consumed: [],
    });
  });

  it("declares nothing for a failed scrape (a failure is never an outcome)", () => {
    expect(pastScrapeDeclaration(row({ status: "failed" }))).toEqual({ skip: "not_completed" });
  });

  it("declares nothing for brand setup, retired PR workflows or unknown callers", () => {
    expect(pastScrapeDeclaration(row({ sourceService: "brand-service" }))).toEqual({ skip: "not_a_prospect_scrape" });
    expect(pastScrapeDeclaration(row({ sourceService: "unknown", workflowSlug: "pr-cold-email-outreach-iris" }))).toEqual({ skip: "not_a_prospect_scrape" });
    expect(pastScrapeDeclaration(row({ workflowSlug: null }))).toEqual({ skip: "not_a_prospect_scrape" });
  });

  it("declares nothing without a run or a company domain", () => {
    expect(pastScrapeDeclaration(row({ runId: null }))).toEqual({ skip: "no_run" });
    expect(pastScrapeDeclaration(row({ url: "not a url" }))).toEqual({ skip: "no_company_domain" });
  });
});

describe("toBatches", () => {
  it("keeps every batch within 500 runs", () => {
    const batches = toBatches(Array.from({ length: 1201 }, (_, i) => entry(i)));
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
  });

  it("keeps every batch within 1000 occurrences", () => {
    const fat = (i: number): BackfillEntry => ({ ...entry(i), produced: Array.from({ length: 3 }, () => entry(i).produced[0]) });
    const batches = toBatches(Array.from({ length: 400 }, (_, i) => fat(i)));
    expect(batches.every((b) => b.reduce((n, e) => n + e.produced.length, 0) <= 1000)).toBe(true);
    expect(batches.flat()).toHaveLength(400);
  });
});

describe("declareBatch", () => {
  it("returns runs-service's counts (a replay is all already_recorded)", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, body: { recordedCount: 0, alreadyRecordedCount: 2 } });
    expect(await declareBatch([entry(1), entry(2)], post)).toEqual({ recordedCount: 0, alreadyRecordedCount: 2, runNotFound: [] });
  });

  it("drops runs runs-service does not know and re-sends the rest", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 422, body: { error: "invalid_runs", details: { invalid: [{ runId: entry(1).runId, reason: "run_not_found" }] } } })
      .mockResolvedValueOnce({ status: 201, body: { recordedCount: 1, alreadyRecordedCount: 0 } });
    const r = await declareBatch([entry(1), entry(2)], post);
    expect(r).toEqual({ recordedCount: 1, alreadyRecordedCount: 0, runNotFound: [entry(1).runId] });
    expect(post.mock.calls[1][0]).toEqual([entry(2)]);
  });

  it("stops loud on any other refusal", async () => {
    const post = vi.fn().mockResolvedValue({ status: 422, body: { details: { invalid: [{ runId: entry(1).runId, reason: "run_org_mismatch" }] } } });
    await expect(declareBatch([entry(1)], post)).rejects.toBeInstanceOf(BackfillError);
    const post502 = vi.fn().mockResolvedValue({ status: 502, body: { error: "outcome_catalogue_unavailable" } });
    await expect(declareBatch([entry(1)], post502)).rejects.toBeInstanceOf(BackfillError);
  });
});
