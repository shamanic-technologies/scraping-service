import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("KEY_SERVICE_URL", "https://key.test.org");
vi.stubEnv("KEY_SERVICE_API_KEY", "test-key-service-key");

const { resolveKey, KeyServiceError } = await import(
  "../../src/lib/key-client.js"
);

describe("key-client", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveKey — auto-resolution", () => {
    it("should call GET /keys/{provider}/decrypt with orgId and userId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ provider: "firecrawl", key: "fc-key", keySource: "org" }),
      });

      const result = await resolveKey({
        provider: "firecrawl",
        orgId: "org_abc",
        userId: "user_123",
        caller: { method: "POST", path: "/scrape" },
      });

      expect(result).toEqual({ provider: "firecrawl", key: "fc-key", keySource: "org" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://key.test.org/keys/firecrawl/decrypt?orgId=org_abc&userId=user_123",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "x-api-key": "test-key-service-key",
            "x-caller-service": "scraping-service",
            "x-caller-method": "POST",
            "x-caller-path": "/scrape",
          }),
        })
      );
    });

    it("should return keySource 'platform' when platform key is used", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ provider: "firecrawl", key: "fc-platform", keySource: "platform" }),
      });

      const result = await resolveKey({
        provider: "firecrawl",
        orgId: "org_abc",
        userId: "user_123",
        caller: { method: "POST", path: "/map" },
      });

      expect(result.keySource).toBe("platform");
    });

    it("should URI-encode orgId and userId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ provider: "firecrawl", key: "fc-key", keySource: "org" }),
      });

      await resolveKey({
        provider: "firecrawl",
        orgId: "org_abc+def",
        userId: "user_1&2",
        caller: { method: "POST", path: "/scrape" },
      });

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("orgId=org_abc%2Bdef");
      expect(calledUrl).toContain("userId=user_1%262");
    });

    it("should throw if orgId is missing", async () => {
      await expect(
        resolveKey({
          provider: "firecrawl",
          orgId: "",
          userId: "user_123",
          caller: { method: "POST", path: "/scrape" },
        })
      ).rejects.toThrow("orgId is required");
    });

    it("should throw if userId is missing", async () => {
      await expect(
        resolveKey({
          provider: "firecrawl",
          orgId: "org_abc",
          userId: "",
          caller: { method: "POST", path: "/scrape" },
        })
      ).rejects.toThrow("userId is required");
    });
  });

  describe("resolveKey — error handling", () => {
    it("should throw KeyServiceError with statusCode on 404", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Key not configured"),
      });

      await expect(
        resolveKey({
          provider: "firecrawl",
          orgId: "org_abc",
          userId: "user_123",
          caller: { method: "POST", path: "/scrape" },
        })
      ).rejects.toThrow(KeyServiceError);

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Key not configured"),
      });

      try {
        await resolveKey({
          provider: "firecrawl",
          orgId: "org_abc",
          userId: "user_123",
          caller: { method: "POST", path: "/scrape" },
        });
      } catch (err) {
        expect((err as InstanceType<typeof KeyServiceError>).statusCode).toBe(404);
      }
    });

    it("should throw KeyServiceError with statusCode on 500", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        resolveKey({
          provider: "firecrawl",
          orgId: "org_abc",
          userId: "user_123",
          caller: { method: "POST", path: "/map" },
        })
      ).rejects.toThrow(KeyServiceError);
    });
  });
});
