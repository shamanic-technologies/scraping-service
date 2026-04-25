import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db module
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

  it("should update scrape_requests and return counts", async () => {
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

  it("should only set orgId when targetBrandId is absent", async () => {
    mockReturning.mockResolvedValue([]);

    await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-key")
      .send({
        sourceBrandId: "00000000-0000-0000-0000-000000000001",
        sourceOrgId: "org-source",
        targetOrgId: "org-target",
      });

    expect(mockSet).toHaveBeenCalledWith({ orgId: "org-target" });
  });

  it("should set both orgId and brandIds when targetBrandId is present", async () => {
    mockReturning.mockResolvedValue([{ id: "row-1" }]);

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
    expect(mockSet).toHaveBeenCalledWith({
      orgId: "org-target",
      brandIds: ["00000000-0000-0000-0000-000000000002"],
    });
    expect(response.body).toEqual({
      updatedTables: [{ tableName: "scrape_requests", count: 1 }],
    });
  });
});
