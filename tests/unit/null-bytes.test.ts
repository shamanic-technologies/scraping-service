import { describe, it, expect } from "vitest";
import { stripNullBytes } from "../../src/lib/sanitize.js";

/**
 * Regression test for: PostgresError: invalid byte sequence for encoding "UTF8": 0x00
 *
 * Some scraped pages (e.g. PDF invoice downloads from ebill.checkpoint.thomsonreuters.com)
 * return content with null bytes (0x00). PostgreSQL text columns reject these.
 */
describe("stripNullBytes", () => {
  it("should remove null bytes from strings", () => {
    expect(stripNullBytes("Hello\x00World")).toBe("HelloWorld");
  });

  it("should remove multiple null bytes", () => {
    expect(stripNullBytes("\x00abc\x00def\x00")).toBe("abcdef");
  });

  it("should return unchanged string when no null bytes present", () => {
    expect(stripNullBytes("normal string")).toBe("normal string");
  });

  it("should handle null input", () => {
    expect(stripNullBytes(null)).toBeNull();
  });

  it("should handle undefined input", () => {
    expect(stripNullBytes(undefined)).toBeUndefined();
  });

  it("should handle empty string", () => {
    expect(stripNullBytes("")).toBe("");
  });

  it("should preserve valid UTF-8 multibyte characters", () => {
    expect(stripNullBytes("café\x00résumé")).toBe("caférésumé");
  });
});
