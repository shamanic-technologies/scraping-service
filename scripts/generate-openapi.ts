import swaggerAutogen from "swagger-autogen";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const doc = {
  info: {
    title: "Scraping Service",
    description:
      "URL scraping service using Firecrawl - extracts company information from websites",
    version: "0.1.0",
  },
  host: process.env.SERVICE_URL || "http://localhost:3010",
  basePath: "/",
  schemes: ["https"],
  securityDefinitions: {
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
    },
  },
};

const outputFile = join(projectRoot, "openapi.json");
const routes = [join(projectRoot, "src/index.ts")];

swaggerAutogen({ openapi: "3.0.0" })(outputFile, routes, doc);
