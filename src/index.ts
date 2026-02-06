import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import healthRoutes from "./routes/health.js";
import scrapeRoutes from "./routes/scrape.js";
import mapRoutes from "./routes/map.js";
import { serviceAuth } from "./middleware/auth.js";
import { db } from "./db/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3010;

// CORS - allow all origins (auth is via API key)
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-API-Key", "X-Source-Service"],
}));

app.use(express.json());

// OpenAPI spec endpoint
const openapiPath = join(__dirname, "..", "openapi.json");
app.get("/openapi.json", (req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
  }
});

// Auth middleware (skips health routes)
app.use(serviceAuth);

// Routes
app.use(healthRoutes);
app.use(scrapeRoutes);
app.use(mapRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`Service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
