const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";

function getApiKey(): string {
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!key) throw new Error("RUNS_SERVICE_API_KEY is not set");
  return key;
}

export interface IdentityContext {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

async function callRunsService<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": getApiKey(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`RunsService ${options.method || "GET"} ${path} failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<T>;
}

export interface CreateRunParams {
  taskName: string;
  brandId?: string;
  campaignId?: string;
  workflowName?: string;
}

export interface Run {
  id: string;
  organizationId: string;
  userId: string | null;
  brandId: string | null;
  campaignId: string | null;
  workflowName: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  parentRunId: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Cost {
  id: string;
  runId: string;
  costName: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  createdAt: string;
}

function identityHeaders(identity: IdentityContext): Record<string, string> {
  const headers: Record<string, string> = {
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
  };
  if (identity.runId) {
    headers["x-run-id"] = identity.runId;
  }
  if (identity.campaignId) {
    headers["x-campaign-id"] = identity.campaignId;
  }
  if (identity.brandId) {
    headers["x-brand-id"] = identity.brandId;
  }
  if (identity.workflowName) {
    headers["x-workflow-name"] = identity.workflowName;
  }
  return headers;
}

export async function createRun(params: CreateRunParams, identity: IdentityContext): Promise<Run> {
  return callRunsService<Run>("/v1/runs", {
    method: "POST",
    headers: identityHeaders(identity),
    body: JSON.stringify({
      serviceName: "scraping-service",
      taskName: params.taskName,
      ...(params.brandId && { brandId: params.brandId }),
      ...(params.campaignId && { campaignId: params.campaignId }),
      ...(params.workflowName && { workflowName: params.workflowName }),
    }),
  });
}

export async function updateRunStatus(
  id: string,
  status: "completed" | "failed",
  identity: IdentityContext
): Promise<Run> {
  return callRunsService<Run>(`/v1/runs/${id}`, {
    method: "PATCH",
    headers: identityHeaders(identity),
    body: JSON.stringify({ status }),
  });
}

export async function addCosts(
  id: string,
  items: { costName: string; quantity: number; costSource: "platform" | "org" }[],
  identity: IdentityContext
): Promise<{ costs: Cost[] }> {
  return callRunsService<{ costs: Cost[] }>(`/v1/runs/${id}/costs`, {
    method: "POST",
    headers: identityHeaders(identity),
    body: JSON.stringify({ items }),
  });
}
