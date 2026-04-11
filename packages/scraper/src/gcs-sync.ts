/**
 * Uploads canonical JSON under DATA_DIR to GCS when SCRAPER_STORAGE=gcs.
 */
import { Storage } from "@google-cloud/storage";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { DATA_DIR } from "./repo-paths.js";

const DEFAULT_BUCKET = "israelscraper";

/** קבצים שמסנכרנים ל-GCS אחרי סריקה מוצלחת (אותה רשימה כמו ב-/data ב-server). */
const SYNC_FILES = [
  "scan-export.json",
  "bus-alerts.json",
  "routes-database.json",
  "egged-alerts.json",
  "agencies-registry.json",
  "bus-alerts-prev.json",
  "busnearby-agency-exclusions.json",
  "ai-summaries.json",
  "settings.json",
  "alert-activity.json",
] as const;

function normalizePrefix(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function uploadDataArtifactsToGcs(): Promise<string[]> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return [];
  }
  const bucketName =
    process.env.GCS_BUCKET_NAME?.trim() || DEFAULT_BUCKET;
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const prefix = normalizePrefix(process.env.GCS_OBJECT_PREFIX?.trim() ?? "");

  const storage = projectId
    ? new Storage({ projectId })
    : new Storage();
  const bucket = storage.bucket(bucketName);
  const uploaded: string[] = [];

  for (const name of SYNC_FILES) {
    const localPath = path.join(DATA_DIR, name);
    try {
      await access(localPath);
    } catch {
      continue;
    }
    const objectName = prefix ? `${prefix}/${name}` : name;
    await bucket.upload(localPath, {
      destination: objectName,
      metadata: { contentType: "application/json" },
    });
    uploaded.push(`gs://${bucketName}/${objectName}`);
  }

  return uploaded;
}

/**
 * מוריד קובץ JSON מ-GCS באותו נתיב כמו ב-upload (bucket + GCS_OBJECT_PREFIX).
 * מחזיר null אם האובייקט לא קיים או אם אינו במצב gcs.
 */
export async function readDataArtifactFromGcs(
  fileName: string
): Promise<string | null> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return null;
  }
  const bucketName =
    process.env.GCS_BUCKET_NAME?.trim() || DEFAULT_BUCKET;
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const prefix = normalizePrefix(process.env.GCS_OBJECT_PREFIX?.trim() ?? "");
  const objectName = prefix ? `${prefix}/${fileName}` : fileName;

  try {
    const storage = projectId
      ? new Storage({ projectId })
      : new Storage();
    const [buf] = await storage
      .bucket(bucketName)
      .file(objectName)
      .download();
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

const ROUTES_DATABASE_FILE = "routes-database.json";

async function localRoutesDatabaseNeedsHydration(
  localPath: string
): Promise<boolean> {
  try {
    await access(localPath);
  } catch {
    return true;
  }
  try {
    const raw = (await readFile(localPath, "utf-8")).trim();
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { routes?: unknown };
    return !Array.isArray(parsed.routes) || parsed.routes.length === 0;
  } catch {
    return true;
  }
}

/**
 * When SCRAPER_STORAGE=gcs, if routes-database.json is missing or empty on disk,
 * download it from GCS so busnearby can run without a full --refresh on a cold volume.
 */
export async function hydrateRoutesDatabaseFromGcsIfConfigured(): Promise<boolean> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return false;
  }
  const localPath = path.join(DATA_DIR, ROUTES_DATABASE_FILE);
  if (!(await localRoutesDatabaseNeedsHydration(localPath))) {
    return false;
  }
  const json = await readDataArtifactFromGcs(ROUTES_DATABASE_FILE);
  if (json === null || !json.trim()) {
    return false;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(localPath, json, "utf-8");
  console.log(`[gcs-sync] Hydrated ${ROUTES_DATABASE_FILE} from GCS`);
  return true;
}
