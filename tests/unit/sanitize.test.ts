import { describe, it, expect } from "vitest";
import { sanitizeForPostgres, MAX_MARKDOWN_LENGTH } from "../../src/lib/sanitize.js";

describe("sanitizeForPostgres", () => {
  it("strips null bytes from text", () => {
    const input = "Hello\x00World\x00!";
    expect(sanitizeForPostgres(input)).toBe("HelloWorld!");
  });

  it("strips multiple consecutive null bytes", () => {
    const input = "PDF\x00\x00\x00content";
    expect(sanitizeForPostgres(input)).toBe("PDFcontent");
  });

  it("returns null for null input", () => {
    expect(sanitizeForPostgres(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(sanitizeForPostgres(undefined)).toBeNull();
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeForPostgres("")).toBe("");
  });

  it("returns clean text unchanged", () => {
    expect(sanitizeForPostgres("Normal text")).toBe("Normal text");
  });

  it("truncates text to maxLength", () => {
    const input = "a".repeat(1000);
    expect(sanitizeForPostgres(input, 500)).toBe("a".repeat(500));
  });

  it("does not truncate text shorter than maxLength", () => {
    const input = "short text";
    expect(sanitizeForPostgres(input, 500)).toBe("short text");
  });

  it("strips null bytes before truncating", () => {
    const input = "\x00".repeat(100) + "a".repeat(200);
    expect(sanitizeForPostgres(input, 150)).toBe("a".repeat(150));
  });

  it("MAX_MARKDOWN_LENGTH is 512KB", () => {
    expect(MAX_MARKDOWN_LENGTH).toBe(512 * 1024);
  });
});
