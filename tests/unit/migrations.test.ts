import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const drizzleDir = join(process.cwd(), "drizzle");
const metaDir = join(drizzleDir, "meta");

describe("drizzle migrations", () => {
  it("drizzle/ directory exists", () => {
    expect(existsSync(drizzleDir)).toBe(true);
  });

  it("meta/_journal.json exists and is valid", () => {
    const journalPath = join(metaDir, "_journal.json");
    expect(existsSync(journalPath)).toBe(true);

    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    expect(journal).toHaveProperty("version");
    expect(journal).toHaveProperty("dialect", "postgresql");
    expect(journal).toHaveProperty("entries");
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("at least one SQL migration file exists", () => {
    const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);
  });

  it("each journal entry has a matching SQL file", () => {
    const journal = JSON.parse(
      readFileSync(join(metaDir, "_journal.json"), "utf-8")
    );

    for (const entry of journal.entries) {
      const sqlPath = join(drizzleDir, `${entry.tag}.sql`);
      expect(existsSync(sqlPath), `Missing SQL file for ${entry.tag}`).toBe(
        true
      );
    }
  });
});
