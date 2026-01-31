import "dotenv/config";
import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health.js";
import scrapeRoutes from "./routes/scrape.js";
import { serviceAuth } from "./middleware/auth.js";

const app = express();
const PORT = process.env.PORT || 3010;

// CORS - allow all origins (auth is via API key)
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-API-Key", "X-Source-Service"],
}));

app.use(express.json());

// Auth middleware (skips health routes)
app.use(serviceAuth);

// Routes
app.use(healthRoutes);
app.use(scrapeRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Listen on :: for Railway private networking (IPv4 & IPv6 support)
app.listen(Number(PORT), "::", () => {
  console.log(`Scraping service running on port ${PORT}`);
});

export default app;
