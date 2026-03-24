import { IdentityContext } from "./runs-client.js";

export interface AuthorizeCostItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeResult {
  sufficient: boolean;
  balance_cents: number | null;
  required_cents: number | null;
  billing_mode: string;
}

function getBillingServiceUrl(): string {
  const url = process.env.BILLING_SERVICE_URL;
  if (!url) throw new Error("BILLING_SERVICE_URL is not set");
  return url;
}

function getBillingApiKey(): string {
  const key = process.env.BILLING_SERVICE_API_KEY;
  if (!key) throw new Error("BILLING_SERVICE_API_KEY is not set");
  return key;
}

/**
 * Request credit authorization from billing-service before executing a paid platform operation.
 * Only call this when costSource is "platform" — BYOK (costSource: "org") skips authorization.
 *
 * Send costName + quantity (the same you use with addCosts via runs-service).
 * billing-service resolves the unit price internally.
 */
export async function authorizeCredits(
  items: AuthorizeCostItem[],
  description: string,
  identity: IdentityContext
): Promise<AuthorizeResult> {
  const url = `${getBillingServiceUrl()}/v1/credits/authorize`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": getBillingApiKey(),
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
  };

  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowName) headers["x-workflow-name"] = identity.workflowName;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, description }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Billing-service authorize failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<AuthorizeResult>;
}
