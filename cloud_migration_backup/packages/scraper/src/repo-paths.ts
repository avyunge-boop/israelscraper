/**
 * נתיבים קנוניים ביחס לשורש ה-repository (תיקייה שבה נמצא scripts/package.json).
 * משמש סקרייפרים, orchestrator ומיגרציה מקבצים ישנים בשורש.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** scripts/src → …/scripts; עוד רמה אחת → שורש ה-repo */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const DATA_DIR = path.join(REPO_ROOT, "data");

/** קובץ env יחיד בשורש ה-workspace */
export const ENV_FILE = path.join(REPO_ROOT, ".env");

export const SCAN_EXPORT_JSON = path.join(DATA_DIR, "scan-export.json");
export const ROUTES_DATABASE_JSON = path.join(DATA_DIR, "routes-database.json");
export const BUS_ALERTS_JSON = path.join(DATA_DIR, "bus-alerts.json");
export const BUS_ALERTS_PREV_JSON = path.join(DATA_DIR, "bus-alerts-prev.json");
export const AGENCIES_REGISTRY_JSON = path.join(DATA_DIR, "agencies-registry.json");
export const EGGED_ALERTS_JSON = path.join(DATA_DIR, "egged-alerts.json");

/** מיקומים לפני איחוד ל־data/ */
export const LEGACY_ROUTES_DB = path.join(REPO_ROOT, "routes-database.json");
export const LEGACY_SCAN_EXPORT = path.join(REPO_ROOT, "scan-export.json");
export const LEGACY_BUS_ALERTS = path.join(REPO_ROOT, "bus-alerts.json");
export const LEGACY_BUS_PREV = path.join(REPO_ROOT, "bus-alerts-prev.json");
export const LEGACY_REGISTRY = path.join(REPO_ROOT, "agencies-registry.json");

export async function ensureRepoDataDir(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function loadRootEnv(): void {
  loadDotenv({ path: ENV_FILE });
}

/** העתקת קובץ אם היעד חסר והמקור קיים */
export async function migrateLegacyFileIfNeeded(
  legacyPath: string,
  targetPath: string,
  fs: typeof import("fs/promises")
): Promise<void> {
  if (existsSync(targetPath)) return;
  try {
    await fs.access(legacyPath);
    await ensureRepoDataDir();
    await fs.copyFile(legacyPath, targetPath);
    console.log(`[paths] Migrated ${legacyPath} → ${targetPath}`);
  } catch {
    /* אין מקור */
  }
}
