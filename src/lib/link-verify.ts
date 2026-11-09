/**
 * Is a backlink LIVE now? Fetch the referring page and look for an <a href> whose host
 * is the brand's domain (or a subdomain of it). Free (a direct HTTP GET from our box).
 *  - verified: the page holds the link now
 *  - not_linking: the page answered, no link to the brand on it
 *  - unreachable: the page did not answer (timeout, 4xx/5xx, blocked)
 * Only `verified` links are kept; the others are retried by the brand's next check.
 */

import type { FetchLike } from "./treg-meter.js";
import { stripWww } from "./backlink-provider.js";

export type Verification = "verified" | "not_linking" | "unreachable";

const MAX_BYTES = 3_000_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** True when the HTML holds an anchor pointing at `brandDomain` or one of its subdomains. */
export function htmlLinksTo(html: string, brandDomain: string): boolean {
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const target = stripWww(brandDomain);
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&amp;/g, "&");
    const hm = /^(?:https?:)?\/\/([^/?#:]+)/i.exec(href);
    if (!hm) continue;
    const host = stripWww(hm[1]);
    if (host === target || host.endsWith(`.${target}`)) return true;
  }
  return false;
}

export async function verifyLink(referringUrl: string, brandDomain: string, fetchImpl: FetchLike = fetch): Promise<Verification> {
  let res: Response;
  try {
    res = await fetchImpl(referringUrl, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return "unreachable";
  }
  if (!res.ok) return "unreachable";
  let html: string;
  try {
    html = (await res.text()).slice(0, MAX_BYTES);
  } catch {
    return "unreachable";
  }
  return htmlLinksTo(html, brandDomain) ? "verified" : "not_linking";
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
