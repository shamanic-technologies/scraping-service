/**
 * The brand's website, read from brand-service (source of truth for brands):
 * `GET /internal/brands/{id}` -> { id, domain, url, ... }. A brand without a
 * domain or url is a named refusal (`brand_has_no_site`), never a guess.
 */

import { BacklinkError, type FetchLike } from "./treg-meter.js";
import { errorMessage } from "./db-error.js";
import { stripWww } from "./backlink-provider.js";

export async function brandSiteDomain(brandId: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const url = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) throw new BacklinkError("service_misconfigured", 502, "BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not set");
  let res: Response;
  try {
    res = await fetchImpl(`${url}/internal/brands/${encodeURIComponent(brandId)}`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new BacklinkError("brand_service_unavailable", 502, `brand-service unreachable: ${errorMessage(err)}`);
  }
  if (res.status === 404) throw new BacklinkError("brand_not_found", 404, `brand ${brandId} not found`);
  const text = await res.text();
  if (!res.ok) throw new BacklinkError("brand_service_unavailable", 502, `brand-service answered ${res.status}: ${text.slice(0, 200)}`);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    body = (parsed.brand as Record<string, unknown> | undefined) ?? parsed;
  } catch {
    throw new BacklinkError("brand_service_unavailable", 502, "brand-service answered a body that is not JSON");
  }
  const domain = siteDomainOf(typeof body.domain === "string" ? body.domain : null) ?? siteDomainOf(typeof body.url === "string" ? body.url : null);
  if (!domain) throw new BacklinkError("brand_has_no_site", 422, `brand ${brandId} has no website`);
  return domain;
}

/** "https://www.Distribute.you/x" -> "distribute.you"; null when no usable host. */
export function siteDomainOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "");
  s = stripWww(s);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}
