/**
 * מיזוג קבצי data/ מתוך b_UUco9SpqaeI/data לתוך שורש-repo/data (חד-פעמי / אחרי שינוי מבנה).
 * הרצה: pnpm --filter @workspace/scraper run consolidate-data
 */
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import {
  DATA_DIR,
  LEGACY_SCAN_EXPORT,
  REPO_ROOT,
  SCAN_EXPORT_JSON,
} from "./repo-paths";

const NESTED_DATA = path.join(REPO_ROOT, "b_UUco9SpqaeI", "data");

async function copyLegacyScanExportToData(): Promise<void> {
  if (existsSync(SCAN_EXPORT_JSON)) return;
  if (!existsSync(LEGACY_SCAN_EXPORT)) return;
  await mkdir(DATA_DIR, { recursive: true });
  const raw = await readFile(LEGACY_SCAN_EXPORT, "utf-8");
  await writeFile(SCAN_EXPORT_JSON, raw, "utf-8");
  console.log(`Copied ${LEGACY_SCAN_EXPORT} → ${SCAN_EXPORT_JSON}`);
}

async function mergeJsonById(
  targetName: string,
  mergeKey: "byId"
): Promise<void> {
  const rootPath = path.join(DATA_DIR, targetName);
  const nestPath = path.join(NESTED_DATA, targetName);
  const merged: Record<string, string> = {};
  for (const p of [rootPath, nestPath]) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(await readFile(p, "utf-8")) as {
        byId?: Record<string, unknown>;
      };
      const bag = raw[mergeKey];
      if (bag && typeof bag === "object") {
        for (const [k, v] of Object.entries(bag)) {
          if (typeof v === "string" && v.trim()) merged[k] = v.trim();
        }
      }
    } catch {
      /* */
    }
  }
  if (Object.keys(merged).length === 0) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    rootPath,
    JSON.stringify({ [mergeKey]: merged }, null, 2),
    "utf-8"
  );
  console.log(`Merged ${targetName} → ${rootPath} (${Object.keys(merged).length} keys)`);
}

async function mergeSettings(): Promise<void> {
  const rootPath = path.join(DATA_DIR, "settings.json");
  const nestPath = path.join(NESTED_DATA, "settings.json");
  let out: Record<string, unknown> = {};
  for (const p of [rootPath, nestPath]) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(await readFile(p, "utf-8")) as Record<string, unknown>;
      out = { ...out, ...j };
    } catch {
      /* */
    }
  }
  if (Object.keys(out).length === 0) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(rootPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Merged settings.json → ${rootPath}`);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await copyLegacyScanExportToData();
  await mergeJsonById("ai-summaries.json", "byId");
  await mergeSettings();
  console.log("Done. Canonical data dir:", DATA_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
