import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "..", "openapi.json");

describe("OpenAPI spec", () => {
  it("should have a generated openapi.json file", () => {
    expect(existsSync(openapiPath)).toBe(true);
  });

  it("should be valid OpenAPI 3.0", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toBe("Scraping Service");
    expect(spec.info.version).toBe("0.1.0");
  });

  it("should include all endpoints", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    const paths = Object.keys(spec.paths);
    expect(paths).toContain("/");
    expect(paths).toContain("/health");
    expect(paths).toContain("/scrape");
    expect(paths).toContain("/scrape/{id}");
    expect(paths).toContain("/scrape/by-url");
    expect(paths).toContain("/map");
    expect(paths).toContain("/openapi.json");
  });

  it("should include security scheme for API key", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.components.securitySchemes.apiKey).toEqual({
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
    });
  });
});
