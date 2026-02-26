const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";

function getApiKey(): string {
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!key) throw new Error("RUNS_SERVICE_API_KEY is not set");
  return key;
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
  orgId: string;
  appId?: string;
  taskName: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  parentRunId?: string;
  workflowName?: string;
}

export interface Run {
  id: string;
  organizationId: string;
  userId: string | null;
  appId: string;
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

export async function createRun(params: CreateRunParams): Promise<Run> {
  return callRunsService<Run>("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      orgId: params.orgId,
      appId: params.appId || "mcpfactory",
      serviceName: "scraping-service",
      taskName: params.taskName,
      ...(params.userId && { userId: params.userId }),
      ...(params.brandId && { brandId: params.brandId }),
      ...(params.campaignId && { campaignId: params.campaignId }),
      ...(params.workflowName && { workflowName: params.workflowName }),
      ...(params.parentRunId && { parentRunId: params.parentRunId }),
    }),
  });
}

export async function updateRunStatus(
  id: string,
  status: "completed" | "failed"
): Promise<Run> {
  return callRunsService<Run>(`/v1/runs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function addCosts(
  id: string,
  items: { costName: string; quantity: number }[]
): Promise<{ costs: Cost[] }> {
  return callRunsService<{ costs: Cost[] }>(`/v1/runs/${id}/costs`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}
