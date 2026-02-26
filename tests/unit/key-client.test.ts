import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("KEY_SERVICE_URL", "https://key.test.org");
vi.stubEnv("KEY_SERVICE_API_KEY", "test-key-service-key");

const { decryptByokKey, KeyServiceError } = await import(
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

  describe("decryptByokKey", () => {
    it("should GET /internal/keys/{provider}/decrypt with correct URL and headers", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ provider: "firecrawl", key: "fc-key-123" }),
      });

      const result = await decryptByokKey("firecrawl", "org_abc", {
        method: "POST",
        path: "/scrape",
      });

      expect(result).toEqual({ provider: "firecrawl", key: "fc-key-123" });
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

    it("should pass caller context for /map endpoint", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ provider: "firecrawl", key: "fc-key-456" }),
      });

      await decryptByokKey("firecrawl", "org_xyz", {
        method: "POST",
        path: "/map",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-caller-method": "POST",
            "x-caller-path": "/map",
          }),
        })
      );
    });

    it("should throw KeyServiceError with statusCode on 404", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Key not configured"),
      });

      await expect(
        decryptByokKey("firecrawl", "org_abc", {
          method: "POST",
          path: "/scrape",
        })
      ).rejects.toThrow(KeyServiceError);

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Key not configured"),
      });

      try {
        await decryptByokKey("firecrawl", "org_abc", {
          method: "POST",
          path: "/scrape",
        });
      } catch (err) {
        expect((err as InstanceType<typeof KeyServiceError>).statusCode).toBe(
          404
        );
      }
    });

    it("should throw KeyServiceError with statusCode on 500", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        decryptByokKey("firecrawl", "org_abc", {
          method: "POST",
          path: "/map",
        })
      ).rejects.toThrow(KeyServiceError);
    });

    it("should URI-encode the orgId", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ provider: "firecrawl", key: "fc-key" }),
      });

      await decryptByokKey("firecrawl", "org_abc+def", {
        method: "POST",
        path: "/scrape",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("orgId=org_abc%2Bdef"),
        expect.anything()
      );
    });
  });
});
