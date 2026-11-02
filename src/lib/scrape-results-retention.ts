import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * Retention for `scrape_results`, the scrape cache (BOX-DISK-1101).
 *
 * One row = the latest scrape of one normalized URL: the writer upserts on the
 * UNIQUE `normalized_url` index, so a URL never has two copies, and `expires_at`
 * (created + 7 days) is when the cache stops serving it. The page markdown sits in
 * TOAST: 1.8 GB on 2026-11-02 for 96,694 rows, 96,581 of them past `expires_at`
 * (a May 2026 bulk of 84k sales scrapes nobody re-reads).
 *
 * Who reads an expired row? `POST /scrape` never does (its cache lookup requires
 * `expires_at > now()`). `GET /scrape/:id` and `GET /scrape/by-url` would, but on
 * 2026-11-02 no code in any repo called them and only DEPRECATED workflows named
 * `by-url`; every caller reads `rawMarkdown` off the live `POST /scrape` answer and
 * keeps no result id. So an expired row is dead weight: delete it. Its `scrape_cache`
 * row goes with it (FK ON DELETE CASCADE); a later scrape of the URL re-creates both.
 *
 * Chunks walk `idx_scrape_results_expires`, with a pause between them, so each
 * statement holds its locks briefly. The outer `expires_at` predicate is re-checked
 * on the locked row, so a row a concurrent scrape just refreshed survives. Freed
 * pages are reused by new rows; giving the disk back is a separate VACUUM FULL (ops).
 */
export const GRACE_MS = 24 * 60 * 60 * 1000;

const CHUNK_SIZE = 500;
/** Ceiling on statements per sweep: the first sweep has ~96k rows to drop, later ones a few a day. */
const MAX_CHUNKS_PER_SWEEP = 400;
const PAUSE_BETWEEN_CHUNKS_MS = 200;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 60_000;

export type Execute = (query: SQL) => Promise<number>;
export type Sleep = (ms: number) => Promise<void>;

export type ScrapeResultsPurgeResult = { cutoff: Date; deleted: number; chunks: number; hitChunkCap: boolean };

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const defaultExecute: Execute = async (q) => {
  const res = (await db.execute(q)) as unknown as { count?: number };
  return res.count ?? 0;
};

export async function purgeExpiredScrapeResults(
  execute: Execute = defaultExecute,
  now: Date = new Date(),
  sleep: Sleep = defaultSleep,
): Promise<ScrapeResultsPurgeResult> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  let deleted = 0;
  let chunks = 0;
  for (;;) {
    if (chunks >= MAX_CHUNKS_PER_SWEEP) return { cutoff, deleted, chunks, hitChunkCap: true };
    const n = await execute(sql`
      DELETE FROM scrape_results
      WHERE id IN (
        SELECT id FROM scrape_results
        WHERE expires_at < ${cutoff.toISOString()}::timestamptz
        ORDER BY expires_at LIMIT ${CHUNK_SIZE}
      )
      AND expires_at < ${cutoff.toISOString()}::timestamptz`);
    chunks++;
    deleted += n;
    if (n < CHUNK_SIZE) break;
    await sleep(PAUSE_BETWEEN_CHUNKS_MS);
  }
  return { cutoff, deleted, chunks, hitChunkCap: false };
}

export function startScrapeResultsRetention(): void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    purgeExpiredScrapeResults()
      .then((r) =>
        console.log(
          `[scraping-service] scrape_results retention: deleted=${r.deleted} chunks=${r.chunks} cutoff=${r.cutoff.toISOString()}` +
            (r.hitChunkCap ? " (chunk cap hit, rest next sweep)" : ""),
        ),
      )
      .catch((err) => console.error("[scraping-service] scrape_results retention failed:", err))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, FIRST_TICK_MS);
  setInterval(tick, SWEEP_INTERVAL_MS);
}
