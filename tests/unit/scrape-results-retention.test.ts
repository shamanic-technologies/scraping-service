import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { purgeExpiredScrapeResults, GRACE_MS } from "../../src/lib/scrape-results-retention.js";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const NOW = new Date("2026-11-02T12:00:00.000Z");

describe("purgeExpiredScrapeResults", () => {
  it("deletes only rows expired for longer than the grace, re-checked on the locked row", async () => {
    const seen: SQL[] = [];
    const execute = vi.fn(async (q: SQL) => {
      seen.push(q);
      return 0;
    });
    const r = await purgeExpiredScrapeResults(execute, NOW, async () => {});

    expect(r).toEqual({ cutoff: new Date(NOW.getTime() - GRACE_MS), deleted: 0, chunks: 1, hitChunkCap: false });
    const { sql, params } = render(seen[0]);
    expect(sql).toContain("DELETE FROM scrape_results");
    // Both the chunk picker AND the outer row are bounded by expires_at: a row a live
    // scrape just refreshed (expires_at moved to the future) is not deleted.
    expect(sql.match(/expires_at < \$\d+::timestamptz/g)).toHaveLength(2);
    expect(sql).toContain("ORDER BY expires_at LIMIT");
    expect(params).toContain("2026-11-01T12:00:00.000Z");
    // Never keyed on created_at/updated_at: the cache's own expiry is the rule.
    expect(sql).not.toMatch(/created_at|updated_at/);
  });

  it("loops full chunks with a pause between them and stops on a short chunk", async () => {
    const counts = [500, 500, 37];
    const execute = vi.fn(async () => counts.shift() ?? 0);
    const sleep = vi.fn(async () => {});
    const r = await purgeExpiredScrapeResults(execute, NOW, sleep);

    expect(r.deleted).toBe(1037);
    expect(r.chunks).toBe(3);
    expect(r.hitChunkCap).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops at the per-sweep chunk cap and says so", async () => {
    const execute = vi.fn(async () => 500);
    const r = await purgeExpiredScrapeResults(execute, NOW, async () => {});

    expect(r.hitChunkCap).toBe(true);
    expect(r.chunks).toBe(400);
    expect(r.deleted).toBe(200_000);
  });

  it("propagates a database error instead of reporting a clean sweep", async () => {
    const execute = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(purgeExpiredScrapeResults(execute, NOW, async () => {})).rejects.toThrow("connection reset");
  });
});
