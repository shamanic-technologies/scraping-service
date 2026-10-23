/**
 * Outcome BACKFILL (COST-BACKFILL-1023-SCRAPING): declares, on the PAST scrape runs
 * that paid for them, the outcomes those runs produced, read from our own rows, so
 * runs-service prices them as if declared when the run happened (`occurredAt:
 * "run_started_at"` on its batch door, POST /v1/platform-runs/outcomes/batch).
 *
 * Which past runs produced an outcome (read from `scrape_requests`, one row per run):
 * - A scrape a SALES outreach workflow asked for (`source_service = 'workflow-service'`,
 *   `workflow_slug` of the sales cold-email family) read a PROSPECT's company site:
 *   `company_researched` on that company's normalized domain, the same subject the
 *   live route declares (`scrapeDeclaration`). Only `completed` rows: a failure is
 *   never an outcome.
 * - Everything else declares nothing, never by guess: brand-service scrapes are brand
 *   setup (a support function), the `pr-*` / journalists / outlets scrapes belong to
 *   retired products, a failed scrape produced nothing. Their spend stays "produced none".
 *
 * Idempotent and resumable: runs-service answers `already_recorded` on a replay, so a
 * crashed or repeated pass writes nothing twice. A batch is all-or-nothing on its side:
 * a run it does not know (`run_not_found`) is reported and dropped, the rest re-sent.
 */
import { scrapeDeclaration, type OutcomeDeclaration } from "./outcome-declaration.js";

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const FETCH_TIMEOUT_MS = 120_000;

/** The first day of fleet spend; nothing earlier is backfilled. */
export const BACKFILL_SINCE = "2026-02-02T00:00:00Z";
/** Sales outreach workflows (every version of the family) whose scrapes researched a prospect's company. */
export const SALES_WORKFLOW_SLUG_PREFIX = "sales-cold-email-outreach";
export const BATCH_MAX_RUNS = 500;
export const BATCH_MAX_OCCURRENCES = 1000;

export interface PastScrapeRow {
  runId: string | null;
  url: string;
  sourceService: string;
  workflowSlug: string | null;
  status: string;
}

export interface BackfillEntry extends OutcomeDeclaration {
  runId: string;
  occurredAt: "run_started_at";
}

export type SkipReason = "no_run" | "not_completed" | "not_a_prospect_scrape" | "no_company_domain";

/** What a past scrape produced, or why it declares nothing. */
export function pastScrapeDeclaration(row: PastScrapeRow): BackfillEntry | { skip: SkipReason } {
  if (!row.runId) return { skip: "no_run" };
  if (row.status !== "completed") return { skip: "not_completed" };
  if (row.sourceService !== "workflow-service" || !row.workflowSlug?.startsWith(SALES_WORKFLOW_SLUG_PREFIX)) {
    return { skip: "not_a_prospect_scrape" };
  }
  const body = scrapeDeclaration("company_researched", row.url);
  if (!body) return { skip: "no_company_domain" };
  return { runId: row.runId.toLowerCase(), occurredAt: "run_started_at", ...body };
}

const occurrences = (e: BackfillEntry) => e.produced.length + e.consumed.length;

/** Splits entries into batches within runs-service's limits (500 runs, 1000 occurrences). */
export function toBatches(entries: BackfillEntry[]): BackfillEntry[][] {
  const batches: BackfillEntry[][] = [];
  let current: BackfillEntry[] = [];
  let count = 0;
  for (const e of entries) {
    if (current.length > 0 && (current.length >= BATCH_MAX_RUNS || count + occurrences(e) > BATCH_MAX_OCCURRENCES)) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(e);
    count += occurrences(e);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface BatchResult {
  recordedCount: number;
  alreadyRecordedCount: number;
  runNotFound: string[];
}

export class BackfillError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
    this.name = "BackfillError";
  }
}

type Post = (runs: BackfillEntry[]) => Promise<{ status: number; body: any }>;

export const postBatch: Post = async (runs) => {
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!key) throw new BackfillError("RUNS_SERVICE_API_KEY is not set", null);
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs/outcomes/batch`, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "X-API-Key": key, "x-service-name": "scraping-service" },
    body: JSON.stringify({ runs }),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error body: kept as text for the error message */
  }
  return { status: response.status, body };
};

/**
 * Sends one batch. A 422 naming only unknown runs drops them and re-sends the rest
 * (reported, never declared elsewhere); any other refusal throws: the pass stops loud.
 */
export async function declareBatch(runs: BackfillEntry[], post: Post = postBatch): Promise<BatchResult> {
  const runNotFound: string[] = [];
  let pending = runs;
  while (pending.length > 0) {
    const { status, body } = await post(pending);
    if (status === 200 || status === 201) {
      return { recordedCount: body.recordedCount, alreadyRecordedCount: body.alreadyRecordedCount, runNotFound };
    }
    const invalid: Array<{ runId: string; reason: string }> | undefined = body?.details?.invalid;
    if (status === 422 && invalid?.length && invalid.every((i) => i.reason === "run_not_found")) {
      const missing = new Set(invalid.map((i) => i.runId.toLowerCase()));
      runNotFound.push(...missing);
      pending = pending.filter((r) => !missing.has(r.runId));
      continue;
    }
    throw new BackfillError(`runs-service batch refused: ${status} ${JSON.stringify(body)}`, status);
  }
  return { recordedCount: 0, alreadyRecordedCount: 0, runNotFound };
}
