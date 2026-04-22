// Max raw markdown size: 512KB (PDFs can produce megabytes of content)
export const MAX_MARKDOWN_LENGTH = 512 * 1024;

/**
 * Strip null bytes and optionally truncate text for PostgreSQL compatibility.
 * PostgreSQL text columns reject \x00 (null bytes), which appear in scraped PDF content.
 */
export function sanitizeForPostgres(text: string | undefined | null, maxLength?: number): string | null {
  if (text == null) return null;
  let sanitized = text.replace(/\x00/g, "");
  if (maxLength && sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }
  return sanitized;
}
