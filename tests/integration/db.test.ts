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
        sourceOrgId: "org_test123",
        url: "https://example.com",
        status: "pending",
      })
      .returning();

    expect(inserted.id).toBeDefined();
    expect(inserted.sourceService).toBe("test-service");
    expect(inserted.url).toBe("https://example.com");
    expect(inserted.status).toBe("pending");

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
        sourceOrgId: "org_test123",
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

  it("should insert and query users and orgs", async () => {
    const [org] = await db
      .insert(schema.orgs)
      .values({ clerkOrgId: "org_integration_test" })
      .returning();

    const [user] = await db
      .insert(schema.users)
      .values({ clerkUserId: "user_integration_test" })
      .returning();

    expect(org.clerkOrgId).toBe("org_integration_test");
    expect(user.clerkUserId).toBe("user_integration_test");

    // Clean up
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await db.delete(schema.orgs).where(eq(schema.orgs.id, org.id));
  });

  it("should insert a task run with costs", async () => {
    // Setup: org, user, task
    const [org] = await db
      .insert(schema.orgs)
      .values({ clerkOrgId: "org_cost_test" })
      .returning();

    const [task] = await db
      .insert(schema.tasks)
      .values({ name: "test-scrape-task" })
      .returning();

    const [run] = await db
      .insert(schema.tasksRuns)
      .values({
        taskId: task.id,
        orgId: org.id,
        status: "completed",
      })
      .returning();

    const [cost] = await db
      .insert(schema.tasksRunsCosts)
      .values({
        taskRunId: run.id,
        costName: "firecrawl-credits",
        units: 5,
        costPerUnitInUsdCents: "0.1000000000",
        totalCostInUsdCents: "0.5000000000",
      })
      .returning();

    expect(cost.costName).toBe("firecrawl-credits");
    expect(cost.units).toBe(5);

    // Clean up (cascade from run deletes costs)
    await db.delete(schema.tasksRuns).where(eq(schema.tasksRuns.id, run.id));
    await db.delete(schema.tasks).where(eq(schema.tasks.id, task.id));
    await db.delete(schema.orgs).where(eq(schema.orgs.id, org.id));
  });
});
