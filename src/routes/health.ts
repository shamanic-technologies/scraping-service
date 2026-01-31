import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  res.json({
    name: "Scraping Service",
    version: "0.1.0",
  });
});

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "scraping-service",
  });
});

export default router;
