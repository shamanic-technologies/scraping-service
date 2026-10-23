/**
 * Outcome declaration (COST-ACCOUNTING-1023): a run that spends states the outcome
 * occurrences it PRODUCED, so runs-service can give each one its exact cost.
 *
 * - A scrape run only declares what its caller states it is FOR (`outcomeKey` on the
 *   request): a URL alone does not say whether we read a prospect's company or a
 *   client's own site (brand setup, a support function). A run that declares nothing
 *   rolls into its nearest declaring ancestor (runs-service's rule), so the caller's
 *   own declaration still covers it.
 * - `company_researched` names the company the way lead-service keys it: its
 *   normalized domain (lowercased, no scheme / www / path / port), under
 *   `subjectService: "lead-service"`. Same function as lead-service's
 *   `normalizeDomain` (src/lib/qualification.ts), so a message that consumes the
 *   company's research resolves to this production. No domain = no subject: nothing
 *   is declared and the gap is logged, never an invented id.
 * - Never fails or slows the scrape: declared in the background, retried on a
 *   network error or a 5xx, logged loud when it finally fails. Idempotent on the
 *   runs-service side (a replay reads `already_recorded`).
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const FETCH_TIMEOUT_MS = 10000;

export const DECLARABLE_OUTCOME_KEYS = ["company_researched"] as const;
export type DeclarableOutcomeKey = (typeof DECLARABLE_OUTCOME_KEYS)[number];

export interface OutcomeItem {
  outcomeKey: DeclarableOutcomeKey;
  subjectService: "lead-service";
  subjectId: string;
}

export interface OutcomeDeclaration {
  produced: OutcomeItem[];
  consumed: OutcomeItem[];
}

/** lead-service's company key for a website URL, or null when it holds no usable domain. */
export function companyDomainOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/** What a scrape of `url` produced for the stated outcome, or null when it names no subject. */
export function scrapeDeclaration(outcomeKey: DeclarableOutcomeKey, url: string): OutcomeDeclaration | null {
  const domain = companyDomainOf(url);
  if (!domain) return null;
  return {
    produced: [{ outcomeKey, subjectService: "lead-service", subjectId: domain }],
    consumed: [],
  };
}

export class OutcomeDeclarationError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
    this.name = "OutcomeDeclarationError";
  }
}

const isRetryable = (err: unknown) =>
  !(err instanceof OutcomeDeclarationError) || err.status === null || err.status >= 500 || err.status === 429;

/** One POST /v1/runs/{runId}/outcomes on the run's org. Throws OutcomeDeclarationError. */
export async function postRunOutcomes(
  runId: string,
  body: OutcomeDeclaration,
  identity: { orgId: string; userId: string }
): Promise<{ recordedCount: number; alreadyRecordedCount: number }> {
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!key) throw new OutcomeDeclarationError("RUNS_SERVICE_API_KEY is not set", 0);
  let response: Response;
  try {
    response = await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}/outcomes`, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": key,
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        "x-run-id": runId,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    throw new OutcomeDeclarationError(`network: ${err?.message ?? err}`, null);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new OutcomeDeclarationError(`${response.status} - ${text}`, response.status);
  }
  return response.json() as Promise<{ recordedCount: number; alreadyRecordedCount: number }>;
}

export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 300_000];

/**
 * Declare in the background: never throws, never awaited by the request.
 * Retries a network error / 5xx / 429 on RETRY_DELAYS_MS; a 4xx is a contract bug, logged loud at once.
 */
export async function declareRunOutcomesInBackground(
  runId: string,
  body: OutcomeDeclaration,
  identity: { orgId: string; userId: string },
  delaysMs: number[] = RETRY_DELAYS_MS,
  post: typeof postRunOutcomes = postRunOutcomes
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await post(runId, body, identity);
      return true;
    } catch (err) {
      const last = attempt >= delaysMs.length || !isRetryable(err);
      if (last) {
        console.error(
          `[scraping-service] OUTCOME DECLARATION LOST run=${runId} after ${attempt + 1} attempt(s): ${(err as Error).message} body=${JSON.stringify(body)}`
        );
        return false;
      }
      console.warn(
        `[scraping-service] outcome declaration failed run=${runId} (attempt ${attempt + 1}), retrying in ${delaysMs[attempt]}ms: ${(err as Error).message}`
      );
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/** The scrape route's one entry point: declares what the caller stated, or logs why it cannot. */
export function declareScrapeOutcome(
  outcomeKey: DeclarableOutcomeKey | undefined,
  url: string,
  runId: string | undefined,
  identity: { orgId: string; userId: string }
): void {
  if (!outcomeKey) return;
  if (!runId) {
    console.error(`[scraping-service] OUTCOME DECLARATION LOST: no run for ${outcomeKey} on ${url} (run creation failed)`);
    return;
  }
  const body = scrapeDeclaration(outcomeKey, url);
  if (!body) {
    console.error(`[scraping-service] OUTCOME NOT DECLARED run=${runId}: ${outcomeKey} on ${url} names no company domain`);
    return;
  }
  void declareRunOutcomesInBackground(runId, body, identity);
}
