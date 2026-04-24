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

  const { brandId, sourceOrgId, targetOrgId } = parsed.data;

  // Update scrape_requests where org_id = sourceOrgId AND brand_ids is exactly [brandId]
  const updated = await db
    .update(scrapeRequests)
    .set({ orgId: targetOrgId })
    .where(
      and(
        eq(scrapeRequests.orgId, sourceOrgId),
        sql`${scrapeRequests.brandIds} = ARRAY[${brandId}]::text[]`
      )
    )
    .returning({ id: scrapeRequests.id });

  console.log(
    `[scraping-service] transfer-brand: brandId=${brandId} from=${sourceOrgId} to=${targetOrgId} scrape_requests=${updated.length}`
  );

  return res.json({
    updatedTables: [{ tableName: "scrape_requests", count: updated.length }],
  });
});

export default router;
