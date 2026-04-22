import { describe, it, expect } from "vitest";
import { sanitizeForPostgres, MAX_MARKDOWN_LENGTH } from "../../src/lib/sanitize.js";

/**
 * Regression test for: PostgresError: invalid byte sequence for encoding "UTF8": 0x00
 *
 * Some scraped pages (e.g. PDF invoice downloads from ebill.checkpoint.thomsonreuters.com)
 * return content with null bytes (0x00). PostgreSQL text columns reject these.
 */
describe("sanitizeForPostgres", () => {
  it("should remove null bytes from strings", () => {
    expect(sanitizeForPostgres("Hello\x00World")).toBe("HelloWorld");
  });

  it("should remove multiple null bytes", () => {
    expect(sanitizeForPostgres("\x00abc\x00def\x00")).toBe("abcdef");
  });

  it("should return unchanged string when no null bytes present", () => {
    expect(sanitizeForPostgres("normal string")).toBe("normal string");
  });

  it("should handle null input", () => {
    expect(sanitizeForPostgres(null)).toBeNull();
  });

  it("should handle undefined input", () => {
    expect(sanitizeForPostgres(undefined)).toBeNull();
  });

  it("should handle empty string", () => {
    expect(sanitizeForPostgres("")).toBe("");
  });

  it("should preserve valid UTF-8 multibyte characters", () => {
    expect(sanitizeForPostgres("café\x00résumé")).toBe("caférésumé");
  });

  it("should truncate when maxLength is provided", () => {
    expect(sanitizeForPostgres("abcdef", 3)).toBe("abc");
  });

  it("should not truncate when under maxLength", () => {
    expect(sanitizeForPostgres("abc", 10)).toBe("abc");
  });

  it("should strip null bytes before truncating", () => {
    expect(sanitizeForPostgres("a\x00b\x00c\x00d", 3)).toBe("abc");
  });

  it("should export MAX_MARKDOWN_LENGTH as 512KB", () => {
    expect(MAX_MARKDOWN_LENGTH).toBe(512 * 1024);
  });
});
