/**
 * Backward-compatible entry: Bus Nearby multi-agency scraper only.
 * For other sources use: pnpm --filter @workspace/scraper run scan -- --agency=egged
 */

import { runScan } from "./scrapers/busnearby/busnearby-scraper";

runScan()
  .then((r) => {
    if (!r.success) {
      console.error(r.error ?? "Scan failed");
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error("Scraper failed:", err);
    process.exit(1);
  });
