/**
 * treg, consumed directly and METERED (BACKLINK-ENGINE-1109; human-service
 * `src/lib/treg-meter.ts` is the pattern).
 *
 * One cost name for every treg call: `treg-micro-usd` (quantity = micro-USD).
 * Per call, on the CALLER's run (the script's run: its Units and every cent sit on one
 * run): PROVISION the call's ceiling, AUTHORIZE it against the org's balance when the
 * key is the platform's, EXECUTE with `X-Treg-Route-Max-Cost` = that ceiling, post
 * treg's own `X-Treg-Cost-Micro` as an actual cost, cancel the hold.
 *
 * Fail loud everywhere: a key we cannot read, a hold runs-service did not write, a
 * refused authorization, a non-2xx from treg, a 200 without its charge header: each
 * throws a named error, nothing is served on a guess.
 */

import { randomUUID } from "node:crypto";
import { errorMessage } from "./db-error.js";

export const TREG_BASE = "https://treg.to/call/";
export const TREG_COST_NAME = "treg-micro-usd";
const CALL_TIMEOUT_MS = 60_000;
const HOP_TIMEOUT_MS = 15_000;

/** A named refusal the routes turn into `{ error: code }` with this status. */
export class BacklinkError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BacklinkError";
  }
}

export interface MeterIdentity {
  orgId: string;
  userId: string;
  /** The caller's run: every hold and actual cost is written on it. */
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface TregAnswer {
  status: number;
  body: unknown;
  chargedMicro: number;
}

export type FetchLike = typeof fetch;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new BacklinkError("service_misconfigured", 502, `${name} is not set`);
  return v;
}

export function identityHeaders(identity: MeterIdentity): Record<string, string> {
  return {
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
    ...(identity.brandIds?.length ? { "x-brand-id": identity.brandIds.join(",") } : {}),
    ...(identity.campaignId ? { "x-campaign-id": identity.campaignId } : {}),
    ...(identity.workflowSlug ? { "x-workflow-slug": identity.workflowSlug } : {}),
    ...(identity.featureSlug ? { "x-feature-slug": identity.featureSlug } : {}),
  };
}

async function readJson(res: Response, what: string, code: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new BacklinkError(code, 502, `${what} answered ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BacklinkError(code, 502, `${what} answered a body that is not JSON: ${text.slice(0, 200)}`);
  }
}

export class TregMeter {
  private keys: Promise<{ token: string; org: string; keySource: "org" | "platform" }> | null = null;
  calls = 0;
  chargedMicro = 0;

  constructor(
    private readonly identity: MeterIdentity,
    private readonly callerPath: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async decryptKey(provider: string): Promise<{ key: string; keySource: "org" | "platform" }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${env("KEY_SERVICE_URL")}/keys/${provider}/decrypt`, {
        method: "GET",
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        headers: {
          "x-api-key": env("KEY_SERVICE_API_KEY"),
          "x-caller-service": "scraping-service",
          "x-caller-method": "POST",
          "x-caller-path": this.callerPath,
          ...identityHeaders(this.identity),
        },
      });
    } catch (err) {
      throw new BacklinkError("key_unavailable", 502, `key-service ${provider} unreachable: ${errorMessage(err)}`);
    }
    const body = await readJson(res, `key-service ${provider} decrypt`, "key_unavailable");
    if (typeof body.key !== "string" || (body.keySource !== "org" && body.keySource !== "platform")) {
      throw new BacklinkError("key_unavailable", 502, `key-service ${provider} decrypt answered no key / keySource`);
    }
    return { key: body.key, keySource: body.keySource };
  }

  private resolveKeys() {
    if (!this.keys) {
      this.keys = (async () => {
        const token = await this.decryptKey("treg");
        const org = await this.decryptKey("treg-org");
        return { token: token.key, org: org.key, keySource: token.keySource };
      })();
      this.keys.catch(() => {
        this.keys = null;
      });
    }
    return this.keys;
  }

  private async runsCall(path: string, method: "POST" | "PATCH", body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${env("RUNS_SERVICE_URL")}${path}`, {
        method,
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        headers: { "Content-Type": "application/json", "X-API-Key": env("RUNS_SERVICE_API_KEY"), ...identityHeaders(this.identity) },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new BacklinkError("spend_not_declared", 502, `runs-service ${method} ${path} unreachable: ${errorMessage(err)}`);
    }
    return readJson(res, `runs-service ${method} ${path}`, "spend_not_declared");
  }

  private async addCost(item: { quantity: number; status?: "provisioned"; keySource: "org" | "platform" }): Promise<string | null> {
    const body = await this.runsCall(`/v1/runs/${this.identity.runId}/costs`, "POST", {
      items: [
        {
          costName: TREG_COST_NAME,
          costSource: item.keySource,
          quantity: item.quantity,
          ...(item.status ? { status: item.status } : {}),
          idempotencyKey: `scraping-service:cost:${randomUUID()}`,
        },
      ],
    });
    const costs = body.costs as Array<{ id?: unknown }> | undefined;
    const id = costs?.[0]?.id;
    return typeof id === "string" ? id : null;
  }

  private async cancelHold(costId: string): Promise<void> {
    await this.runsCall(`/v1/runs/${this.identity.runId}/costs/${costId}`, "PATCH", { status: "cancelled" });
  }

  private async authorize(maxMicro: number, description: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${env("BILLING_SERVICE_URL")}/v1/customer_balance/authorize`, {
        method: "POST",
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        headers: { "Content-Type": "application/json", "X-API-Key": env("BILLING_SERVICE_API_KEY"), ...identityHeaders(this.identity) },
        body: JSON.stringify({ items: [{ costName: TREG_COST_NAME, quantity: maxMicro }], description }),
      });
    } catch (err) {
      throw new BacklinkError("billing_unavailable", 502, `billing-service unreachable: ${errorMessage(err)}`);
    }
    const body = await readJson(res, "billing-service authorize", "billing_unavailable");
    if (body.sufficient !== true) {
      throw new BacklinkError("insufficient_credit", 402, "billing-service refused the treg spend", {
        balance_cents: body.balance_cents ?? null,
        required_cents: body.required_cents ?? null,
      });
    }
  }

  /**
   * One metered treg call. `maxMicro` is the most it may cost: provisioned,
   * authorized, and sent as the route ceiling, so treg never charges above it.
   */
  async call(endpoint: string, req: { body: unknown; maxMicro: number }): Promise<TregAnswer> {
    const keys = await this.resolveKeys();
    const holdId = await this.addCost({ quantity: req.maxMicro, status: "provisioned", keySource: keys.keySource });
    if (!holdId) throw new BacklinkError("spend_not_declared", 502, `runs-service returned no cost id for the ${TREG_COST_NAME} hold`);
    let settled = false;
    try {
      if (keys.keySource === "platform") await this.authorize(req.maxMicro, `backlinks: ${endpoint}`);
      let res: Response;
      try {
        res = await this.fetchImpl(`${TREG_BASE}${endpoint}`, {
          method: "POST",
          headers: {
            "X-Treg-Token": keys.token,
            "X-Treg-Org": keys.org,
            "Cache-Control": "no-cache",
            "X-Treg-Route-Max-Cost": (req.maxMicro / 1_000_000).toFixed(6),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch (err) {
        // The call may have reached treg and been billed: keep the hold (never a
        // cost we pretend did not happen); the run reads it as provisioned.
        settled = true;
        throw new BacklinkError("provider_unavailable", 502, `treg ${endpoint} unreachable: ${errorMessage(err)}`);
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { _raw: text.slice(0, 2000) };
      }
      const rawCost = res.headers.get("x-treg-cost-micro");
      let charged = rawCost === null || rawCost.trim() === "" ? null : Number(rawCost);
      if (charged !== null && (!Number.isFinite(charged) || charged < 0)) charged = null;
      if (charged === null) {
        if (res.ok) throw new BacklinkError("spend_not_declared", 502, `treg ${endpoint} answered ${res.status} without X-Treg-Cost-Micro: the charge cannot be declared`);
        charged = 0; // treg bills nothing for a relayed failure
      }
      if (charged > 0) await this.addCost({ quantity: charged, keySource: keys.keySource });
      this.calls++;
      this.chargedMicro += charged;
      if (!res.ok) {
        throw new BacklinkError("provider_unavailable", 502, `treg ${endpoint} answered ${res.status}: ${text.slice(0, 300)}`);
      }
      return { status: res.status, body, chargedMicro: charged };
    } finally {
      if (!settled) await this.cancelHold(holdId);
    }
  }
}
