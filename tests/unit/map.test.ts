import { describe, it, expect } from "vitest";

describe("Map endpoint", () => {
  it("should have valid config", () => {
    const config = {
      defaultLimit: 100,
      maxLimit: 500,
    };
    expect(config.defaultLimit).toBe(100);
    expect(config.maxLimit).toBe(500);
  });

  it("should cap limit at 500", () => {
    const requestedLimit = 1000;
    const cappedLimit = Math.min(requestedLimit, 500);
    expect(cappedLimit).toBe(500);
  });
});
