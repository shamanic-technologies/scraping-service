/**
 * Strip null bytes (0x00) from strings before PostgreSQL insertion.
 * PostgreSQL text columns reject null bytes with:
 * "invalid byte sequence for encoding UTF8: 0x00"
 */
export const stripNullBytes = (s: string | null | undefined): string | null | undefined =>
  s ? s.replace(/\0/g, "") : s;
