import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db module — track each update().set().where().returning() chain
const mockReturning = vi.fn();
const mockWhere = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

import request from "supertest";
import express from "express";
import { serviceAuth } from "../../src/middleware/auth.js";
import transferBrandRoutes from "../../src/routes/transfer-brand.js";

describe("POST /internal/transfer-brand", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SCRAPING_SERVICE_API_KEY", "test-key");

    app = express();
    app.use(express.json());
    app.use(serviceAuth);
    app.use(transferBrandRoutes);

    mockReturning.mockResolvedValue([]);
  });

  it("should require API key auth", async () => {
    const response = await request(app)
      .post("/internal/transfer-brand")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(response.status).toBe(401);
  });

  it("should NOT require x-org-id, x-user-id, or x-run-id headers", async () => {
    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(response.status).toBe(200);
  });

  it("should return 400 for invalid body (missing sourceBrandId)", async () => {
    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(response.status).toBe(400);
  });

  it("should return 400 for invalid sourceBrandId (not UUID)", async () => {
    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "not-a-uuid",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(response.status).toBe(400);
  });

  it("should return 400 for invalid targetBrandId (not UUID)", async () => {
    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
        targetBrandId: "not-a-uuid",
      });

    expect(response.status).toBe(400);
  });

  it("should update scrape_requests and return counts (no targetBrandId)", async () => {
    mockReturning.mockResolvedValue([
      { id: "row-1" },
      { id: "row-2" },
      { id: "row-3" },
    ]);

    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      updatedTables: [{ tableName: "scrape_requests", count: 3 }],
    });
  });

  it("should be idempotent (return 0 when no rows match)", async () => {
    mockReturning.mockResolvedValue([]);

    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      updatedTables: [{ tableName: "scrape_requests", count: 0 }],
    });
  });

  it("should only call db.update once when targetBrandId is absent (step 1 only)", async () => {
    mockReturning.mockResolvedValue([]);

    await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ orgId: "org-target" });
  });

  it("should call db.update twice when targetBrandId is present (step 1 + step 2)", async () => {
    // Step 1 returns moved rows, step 2 returns rewritten rows
    mockReturning
      .mockResolvedValueOnce([{ id: "row-1" }, { id: "row-2" }])
      .mockResolvedValueOnce([{ id: "row-1" }, { id: "row-2" }, { id: "row-3" }]);

    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
        targetBrandId: "00000000-0000-0000-0000-000000000002",
      });

    expect(response.status).toBe(200);
    // Two separate updates
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    // Step 1: only org_id change
    expect(mockSet).toHaveBeenNthCalledWith(1, { orgId: "org-target" });
    // Step 2: only brand_ids rewrite
    expect(mockSet).toHaveBeenNthCalledWith(2, {
      brandIds: ["00000000-0000-0000-0000-000000000002"],
    });
    // Deduped count: row-1, row-2 from step 1 + row-3 from step 2 = 3
    expect(response.body).toEqual({
      updatedTables: [{ tableName: "scrape_requests", count: 3 }],
    });
  });

  it("should deduplicate row IDs across both steps", async () => {
    // Same rows returned by both steps (all already in sourceOrg)
    mockReturning
      .mockResolvedValueOnce([{ id: "row-1" }])
      .mockResolvedValueOnce([{ id: "row-1" }]);

    const response = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
        targetBrandId: "00000000-0000-0000-0000-000000000002",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      updatedTables: [{ tableName: "scrape_requests", count: 1 }],
    });
  });
});
