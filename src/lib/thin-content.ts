/**
 * Thin-content detection.
 *
 * A client-rendered SPA (e.g. a Next.js app) returns a non-empty HTTP 200 body
 * whose *visible* text is near-empty — the real content is injected by JS after
 * load. Byte-length / HTTP-status success checks pass on such a shell, so the
 * scrape escalation chain treats it as a success and never escalates to JS
 * rendering. Measuring visible text instead lets the chain detect the shell and
 * escalate to render+super.
 */

// Minimum visible-text length (chars) for a scrape to count as real content.
// A typical SPA shell yields a few dozen chars ("DialogBrain Skip to main
// content" ~= 32); a real SSR page yields thousands. 200 sits well between.
export const THIN_CONTENT_MIN_CHARS = 200;

/**
 * Approximate the visible-text length of scraped content (markdown or HTML).
 * Strips script/style blocks and tags, collapses whitespace, trims. For markdown
 * the tag-strip is largely a no-op; for raw HTML it removes the scaffolding so an
 * SPA shell measures as the handful of visible chars it actually renders.
 */
export function visibleTextLength(content: string | null | undefined): number {
  if (!content) return 0;
  const text = content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

/** True when the scraped content's visible text is below the thin-content threshold. */
export function isThinContent(content: string | null | undefined): boolean {
  return visibleTextLength(content) < THIN_CONTENT_MIN_CHARS;
}
