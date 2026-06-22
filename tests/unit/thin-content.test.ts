import { describe, it, expect } from "vitest";
import {
  THIN_CONTENT_MIN_CHARS,
  visibleTextLength,
  isThinContent,
} from "../../src/lib/thin-content.js";

describe("visibleTextLength", () => {
  it("returns 0 for empty / null / undefined", () => {
    expect(visibleTextLength(null)).toBe(0);
    expect(visibleTextLength(undefined)).toBe(0);
    expect(visibleTextLength("")).toBe(0);
    expect(visibleTextLength("   \n\t  ")).toBe(0);
  });

  it("measures the visible text of a SPA shell (the dialogbrain.com failure)", () => {
    // What scrape.do returns for a client-rendered Next.js shell: ~22KB of HTML
    // whose only visible text is the brand name + a skip-link.
    const shell =
      '<!DOCTYPE html><html><head><title>DialogBrain</title>' +
      '<script>self.__next_f=[];self.__next_f.push([1,"big chunk of js payload here"])</script>' +
      '<style>.x{color:red}</style></head>' +
      '<body><a href="#main">Skip to main content</a><div id="__next"></div>' +
      '<script src="/_next/static/chunks/main.js"></script></body></html>';
    const len = visibleTextLength(shell);
    // "DialogBrain Skip to main content" ~= 32 visible chars — well below threshold.
    expect(len).toBeLessThan(50);
    expect(len).toBeGreaterThan(0);
  });

  it("strips embedded HTML and collapses whitespace", () => {
    // Markdown syntax (#) is not an HTML tag, so it survives; whitespace collapses.
    expect(visibleTextLength("<p>Hello</p>\n\n  world  ")).toBe("Hello world".length);
  });

  it("counts real content above the threshold", () => {
    const rich = "Our platform offers ".repeat(50); // 1000 chars
    expect(visibleTextLength(rich)).toBeGreaterThan(THIN_CONTENT_MIN_CHARS);
  });
});

describe("isThinContent", () => {
  it("is thin for empty and near-empty content", () => {
    expect(isThinContent(null)).toBe(true);
    expect(isThinContent("DialogBrain Skip to main content")).toBe(true);
  });

  it("is thin at the boundary (< threshold) and not thin at/above it", () => {
    const justUnder = "a".repeat(THIN_CONTENT_MIN_CHARS - 1);
    const atThreshold = "a".repeat(THIN_CONTENT_MIN_CHARS);
    expect(isThinContent(justUnder)).toBe(true);
    expect(isThinContent(atThreshold)).toBe(false);
  });

  it("is not thin for a rich SSR page", () => {
    const rich =
      "Acme builds developer tools for payment infrastructure. ".repeat(20);
    expect(isThinContent(rich)).toBe(false);
  });
});
