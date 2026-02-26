import { describe, it, expect, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";

const client = postgres(process.env.SCRAPING_SERVICE_DATABASE_URL!);
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end();
});

describe("database schema", () => {
  it("should insert and read a scrape request", async () => {
    const [inserted] = await db
      .insert(schema.scrapeRequests)
      .values({
        sourceService: "test-service",
        orgId: "org_test123",
        url: "https://example.com",
        status: "pending",
      })
      .returning();

    expect(inserted.id).toBeDefined();
    expect(inserted.sourceService).toBe("test-service");
    expect(inserted.url).toBe("https://example.com");
    expect(inserted.status).toBe("pending");
    expect(inserted.runId).toBeNull();

    // Clean up
    await db
      .delete(schema.scrapeRequests)
      .where(eq(schema.scrapeRequests.id, inserted.id));
  });

  it("should insert a scrape request with runId", async () => {
    const [inserted] = await db
      .insert(schema.scrapeRequests)
      .values({
        sourceService: "test-service",
        orgId: "org_test123",
        url: "https://example.com",
        runId: "run_abc123",
        status: "processing",
      })
      .returning();

    expect(inserted.runId).toBe("run_abc123");

    // Clean up
    await db
      .delete(schema.scrapeRequests)
      .where(eq(schema.scrapeRequests.id, inserted.id));
  });

  it("should insert a scrape result linked to a request", async () => {
    // Create parent request
    const [request] = await db
      .insert(schema.scrapeRequests)
      .values({
        sourceService: "test-service",
        orgId: "org_test123",
        url: "https://example.com",
        status: "completed",
      })
      .returning();

    // Create result
    const [result] = await db
      .insert(schema.scrapeResults)
      .values({
        requestId: request.id,
        url: "https://example.com",
        normalizedUrl: "example.com",
        companyName: "Example Inc",
        industry: "Technology",
      })
      .returning();

    expect(result.id).toBeDefined();
    expect(result.requestId).toBe(request.id);
    expect(result.companyName).toBe("Example Inc");

    // Clean up (cascade deletes result)
    await db
      .delete(schema.scrapeRequests)
      .where(eq(schema.scrapeRequests.id, request.id));
  });
});
