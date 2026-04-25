import { Router, Request, Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { scrapeRequests } from "../db/schema.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

router.post("/internal/transfer-brand", async (req: Request, res: Response) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  // Step 1: Move rows from sourceOrg to targetOrg (solo-brand only)
  const movedRows = await db
    .update(scrapeRequests)
    .set({ orgId: targetOrgId })
    .where(
      and(
        eq(scrapeRequests.orgId, sourceOrgId),
        sql`${scrapeRequests.brandIds} = ARRAY[${sourceBrandId}]::text[]`
      )
    )
    .returning({ id: scrapeRequests.id });

  let rewrittenRows: { id: string }[] = [];

  // Step 2: If targetBrandId present, rewrite brand_ids on ALL rows with sourceBrandId (no org filter)
  if (targetBrandId) {
    rewrittenRows = await db
      .update(scrapeRequests)
      .set({ brandIds: [targetBrandId] })
      .where(
        sql`${scrapeRequests.brandIds} = ARRAY[${sourceBrandId}]::text[]`
      )
      .returning({ id: scrapeRequests.id });
  }

  const totalUpdated = targetBrandId
    ? new Set([...movedRows.map((r) => r.id), ...rewrittenRows.map((r) => r.id)]).size
    : movedRows.length;

  console.log(
    `[scraping-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} moved=${movedRows.length} rewritten=${rewrittenRows.length} total=${totalUpdated}`
  );

  return res.json({
    updatedTables: [{ tableName: "scrape_requests", count: totalUpdated }],
  });
});

export default router;
