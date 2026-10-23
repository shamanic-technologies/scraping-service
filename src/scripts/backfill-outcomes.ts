/**
 * One-shot backfill of past scrape runs' outcomes (see src/lib/outcome-backfill.ts).
 * Dry run by default (prints what it would declare); `--apply` writes.
 * In prod: docker exec distribute-scraping-service-1 node dist/scripts/backfill-outcomes.js [--apply]
 * Safe to re-run: a replay is `already_recorded` on runs-service, nothing is written twice.
 */
import { asc, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { scrapeRequests } from "../db/schema.js";
import {
  BACKFILL_SINCE,
  declareBatch,
  pastScrapeDeclaration,
  toBatches,
  type BackfillEntry,
  type SkipReason,
} from "../lib/outcome-backfill.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db
    .select({
      runId: scrapeRequests.runId,
      url: scrapeRequests.url,
      sourceService: scrapeRequests.sourceService,
      workflowSlug: scrapeRequests.workflowSlug,
      status: scrapeRequests.status,
    })
    .from(scrapeRequests)
    .where(gte(scrapeRequests.createdAt, new Date(BACKFILL_SINCE)))
    .orderBy(asc(scrapeRequests.createdAt));

  const entries: BackfillEntry[] = [];
  const skipped: Record<SkipReason, number> = { no_run: 0, not_completed: 0, not_a_prospect_scrape: 0, no_company_domain: 0 };
  for (const row of rows) {
    const d = pastScrapeDeclaration(row);
    if ("skip" in d) skipped[d.skip]++;
    else entries.push(d);
  }
  const batches = toBatches(entries);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", rows: rows.length, toDeclare: entries.length, batches: batches.length, skipped }));
  if (!apply) {
    console.log(JSON.stringify({ sample: entries.slice(0, 3) }));
    process.exit(0);
  }

  let recorded = 0;
  let alreadyRecorded = 0;
  const runNotFound: string[] = [];
  for (const [i, batch] of batches.entries()) {
    const r = await declareBatch(batch);
    recorded += r.recordedCount;
    alreadyRecorded += r.alreadyRecordedCount;
    runNotFound.push(...r.runNotFound);
    console.log(`batch ${i + 1}/${batches.length}: recorded=${r.recordedCount} alreadyRecorded=${r.alreadyRecordedCount} runNotFound=${r.runNotFound.length}`);
  }
  console.log(JSON.stringify({ done: true, recorded, alreadyRecorded, runNotFound: runNotFound.length, runNotFoundIds: runNotFound.slice(0, 20) }));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[scraping-service] OUTCOME BACKFILL FAILED: ${err?.message ?? err}`);
  process.exit(1);
});
