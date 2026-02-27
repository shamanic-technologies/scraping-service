import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("KEY_SERVICE_URL", "https://key.test.org");
vi.stubEnv("KEY_SERVICE_API_KEY", "test-key-service-key");

const { resolveKey, decryptByokKey, KeyServiceError } = await import(
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

  describe("resolveKey — byok", () => {
    it("should call /internal/keys/{provider}/decrypt with orgId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ provider: "firecrawl", key: "fc-byok" }),
      });

      const result = await resolveKey({
        provider: "firecrawl",
        keySource: "byok",
        orgId: "org_abc",
        caller: { method: "POST", path: "/scrape" },
      });

      expect(result).toEqual({ provider: "firecrawl", key: "fc-byok" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://key.test.org/internal/keys/firecrawl/decrypt?orgId=org_abc",
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

    it("should throw if orgId is missing for byok", async () => {
      await expect(
        resolveKey({
          provider: "firecrawl",
          keySource: "byok",
          caller: { method: "POST", path: "/scrape" },
        })
      ).rejects.toThrow("orgId is required for keySource 'byok'");
    });

    it("should URI-encode the orgId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ provider: "firecrawl", key: "fc-key" }),
      });

      await resolveKey({
        provider: "firecrawl",
        keySource: "byok",
        orgId: "org_abc+def",
        caller: { method: "POST", path: "/scrape" },
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("orgId=org_abc%2Bdef"),
        expect.anything()
      );
    });
  });

  describe("resolveKey — app", () => {
    it("should call /internal/app-keys/{provider}/decrypt with appId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ provider: "firecrawl", key: "fc-app" }),
      });

      const result = await resolveKey({
        provider: "firecrawl",
        keySource: "app",
        appId: "mcpfactory",
        caller: { method: "POST", path: "/scrape" },
      });

      expect(result).toEqual({ provider: "firecrawl", key: "fc-app" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://key.test.org/internal/app-keys/firecrawl/decrypt?appId=mcpfactory",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should throw if appId is missing for app", async () => {
      await expect(
        resolveKey({
          provider: "firecrawl",
          keySource: "app",
          orgId: "org_abc",
          caller: { method: "POST", path: "/scrape" },
        })
      ).rejects.toThrow("appId is required for keySource 'app'");
    });
  });

  describe("resolveKey — platform", () => {
    it("should call /internal/platform-keys/{provider}/decrypt with no query params", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ provider: "firecrawl", key: "fc-platform" }),
      });

      const result = await resolveKey({
        provider: "firecrawl",
        keySource: "platform",
        caller: { method: "POST", path: "/scrape" },
      });

      expect(result).toEqual({ provider: "firecrawl", key: "fc-platform" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://key.test.org/internal/platform-keys/firecrawl/decrypt",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should not require orgId or appId for platform", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ provider: "firecrawl", key: "fc-platform" }),
      });

      // No orgId, no appId — should not throw
      await expect(
        resolveKey({
          provider: "firecrawl",
          keySource: "platform",
          caller: { method: "POST", path: "/map" },
        })
      ).resolves.toEqual({ provider: "firecrawl", key: "fc-platform" });
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
          keySource: "byok",
          orgId: "org_abc",
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
          keySource: "byok",
          orgId: "org_abc",
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
          keySource: "platform",
          caller: { method: "POST", path: "/map" },
        })
      ).rejects.toThrow(KeyServiceError);
    });
  });

  describe("decryptByokKey (backward compat)", () => {
    it("should delegate to resolveKey with keySource byok", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ provider: "firecrawl", key: "fc-key-123" }),
      });

      const result = await decryptByokKey("firecrawl", "org_abc", {
        method: "POST",
        path: "/scrape",
      });

      expect(result).toEqual({ provider: "firecrawl", key: "fc-key-123" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://key.test.org/internal/keys/firecrawl/decrypt?orgId=org_abc",
        expect.objectContaining({ method: "GET" })
      );
    });
  });
});
