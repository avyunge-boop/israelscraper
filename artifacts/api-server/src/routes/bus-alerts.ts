import { Router, type IRouter } from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = path.resolve(__dirname, "../../../bus-alerts.json");

const router: IRouter = Router();

router.get("/bus-alerts", async (_req, res) => {
  try {
    const raw = await fs.readFile(ALERTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    res.json(data);
  } catch (err: unknown) {
    const isNotFound =
      typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      res.status(404).json({ error: "bus-alerts.json not found. Run the scraper first." });
    } else {
      res.status(500).json({ error: "Failed to read alerts file." });
    }
  }
});

export default router;
