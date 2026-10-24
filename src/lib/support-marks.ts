/**
 * Support marks (LEDGER-HISTORY-1024): a past run of ours whose spend produced no
 * outcome BY DESIGN is marked SUPPORT on runs-service's owner door, naming its
 * function (`/v1/platform-runs/support-marks/{preview,apply}`, x-service-name =
 * scraping-service, our own runs only, all or nothing, idempotent: an already
 * marked run keeps its first function).
 *
 * The list of functions is runs-service's (it adds one, e.g. `unattributed_production`,
 * without a change here). Only for a function our records PROVE (a staff probe of our own site, a run of a
 * retired product). A run that tried to produce an outcome and kept nothing is loss
 * of its pipe, never support: leave it unmarked.
 */
const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const FETCH_TIMEOUT_MS = 120_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The function's name, as runs-service's support-mark door lists it (it refuses an unknown one: 400). */
export type SupportFunction = string;

export interface SupportMarkRequest {
  kind: SupportFunction;
  reason: string;
  markedBy: string;
  runIds: string[];
}

export class SupportMarkError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
    this.name = "SupportMarkError";
  }
}

/** Validates the CLI input before anything reaches runs-service. */
export function supportMarkRequest(kind: string, reason: string, markedBy: string, runIds: string[]): SupportMarkRequest {
  if (!/^[a-z_]+$/.test(kind)) throw new SupportMarkError(`not a support function name: "${kind}"`, null);
  if (!reason.trim()) throw new SupportMarkError("a reason is required", null);
  if (!markedBy.trim()) throw new SupportMarkError("markedBy is required", null);
  const ids = [...new Set(runIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) throw new SupportMarkError("no run ids", null);
  if (ids.length > 5000) throw new SupportMarkError(`${ids.length} runs: at most 5000 per call`, null);
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length) throw new SupportMarkError(`not run ids: ${bad.join(", ")}`, null);
  return { kind, reason: reason.trim(), markedBy: markedBy.trim(), runIds: ids };
}

type Post = (step: "preview" | "apply", body: SupportMarkRequest) => Promise<{ status: number; body: any }>;

export const postSupportMark: Post = async (step, body) => {
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!key) throw new SupportMarkError("RUNS_SERVICE_API_KEY is not set", null);
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs/support-marks/${step}`, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "X-API-Key": key, "x-service-name": "scraping-service" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error body: kept as text for the error message */
  }
  return { status: response.status, body: parsed };
};

/** Preview (writes nothing) or apply. Any refusal throws: nothing is marked by halves. */
export async function markSupport(step: "preview" | "apply", body: SupportMarkRequest, post: Post = postSupportMark): Promise<any> {
  const { status, body: res } = await post(step, body);
  if (status !== 200) throw new SupportMarkError(`runs-service support-marks/${step} refused: ${status} ${JSON.stringify(res)}`, status);
  return res;
}
