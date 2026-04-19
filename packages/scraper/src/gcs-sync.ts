/**
 * Uploads canonical JSON under DATA_DIR to GCS when SCRAPER_STORAGE=gcs.
 */
import { Storage } from "@google-cloud/storage";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { agencyAlertsFileName, listAgencyAlertFilenamesInDataDir } from "./lib/agency-alerts-store.js";
import { ALL_AGENCY_IDS } from "./scrapers/types.js";
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
  "scraper-status.json",
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

  const namesToSync = new Set<string>(SYNC_FILES);
  for (const n of await listAgencyAlertFilenamesInDataDir()) {
    namesToSync.add(n);
  }

  for (const name of namesToSync) {
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
 * Upload one JSON file under DATA_DIR when SCRAPER_STORAGE=gcs (same object path as full sync).
 * Skips if the file is missing locally. Returns gs:// URL or null.
 */
export async function uploadDataJsonFileToGcs(
  fileName: string
): Promise<string | null> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return null;
  }
  const localPath = path.join(DATA_DIR, fileName);
  try {
    await access(localPath);
  } catch {
    return null;
  }
  const bucketName =
    process.env.GCS_BUCKET_NAME?.trim() || DEFAULT_BUCKET;
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const prefix = normalizePrefix(process.env.GCS_OBJECT_PREFIX?.trim() ?? "");
  const objectName = prefix ? `${prefix}/${fileName}` : fileName;
  const storage = projectId ? new Storage({ projectId }) : new Storage();
  const bucket = storage.bucket(bucketName);
  await bucket.upload(localPath, {
    destination: objectName,
    metadata: { contentType: "application/json" },
  });
  return `gs://${bucketName}/${objectName}`;
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

/**
 * Lists object basenames `alerts-<id>.json` in the bucket (same prefix as uploads).
 * Used by the collector on Cloud Run when the local disk has no copies of every agency file.
 */
export async function listAgencyAlertJsonBasenamesInGcs(): Promise<string[]> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return [];
  }
  const bucketName =
    process.env.GCS_BUCKET_NAME?.trim() || DEFAULT_BUCKET;
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const prefix = normalizePrefix(process.env.GCS_OBJECT_PREFIX?.trim() ?? "");
  const listPrefix = prefix ? `${prefix}/alerts-` : "alerts-";

  try {
    const storage = projectId
      ? new Storage({ projectId })
      : new Storage();
    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: listPrefix });
    const out: string[] = [];
    for (const f of files) {
      const base = path.basename(f.name);
      if (/^alerts-[a-z0-9-]+\.json$/i.test(base)) {
        out.push(base);
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
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

const SCAN_EXPORT_FILE = "scan-export.json";

async function localScanExportNeedsHydration(localPath: string): Promise<boolean> {
  try {
    await access(localPath);
  } catch {
    return true;
  }
  try {
    const raw = (await readFile(localPath, "utf-8")).trim();
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { sources?: unknown };
    return !Array.isArray(parsed.sources) || parsed.sources.length === 0;
  } catch {
    return true;
  }
}

/**
 * When SCRAPER_STORAGE=gcs, if scan-export.json is missing or has no sources on disk,
 * download from GCS so a single-agency orchestrator run merges into the previous
 * multi-source export instead of replacing it (Cloud Run ephemeral disk).
 */
export async function hydrateScanExportFromGcsIfConfigured(): Promise<boolean> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return false;
  }
  const localPath = path.join(DATA_DIR, SCAN_EXPORT_FILE);
  if (!(await localScanExportNeedsHydration(localPath))) {
    return false;
  }
  const json = await readDataArtifactFromGcs(SCAN_EXPORT_FILE);
  if (json === null || !json.trim()) {
    return false;
  }
  let sourceCount = 0;
  try {
    const parsed = JSON.parse(json) as { sources?: unknown };
    if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
      return false;
    }
    sourceCount = parsed.sources.length;
  } catch {
    return false;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(localPath, json, "utf-8");
  console.log(
    `[gcs-sync] Hydrated ${SCAN_EXPORT_FILE} from GCS (${sourceCount} source(s))`
  );
  return true;
}

async function localAgencyAlertsFileNeedsHydration(
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
    const parsed = JSON.parse(raw) as { alerts?: unknown };
    return !Array.isArray(parsed.alerts) || parsed.alerts.length === 0;
  } catch {
    return true;
  }
}

/**
 * Pull data/alerts-<id>.json from GCS when local copy is missing or empty (Cloud Run).
 */
export async function hydrateAgencyAlertFilesFromGcs(): Promise<number> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return 0;
  }
  let count = 0;
  for (const id of ALL_AGENCY_IDS) {
    const name = agencyAlertsFileName(id);
    const localPath = path.join(DATA_DIR, name);
    if (!(await localAgencyAlertsFileNeedsHydration(localPath))) {
      continue;
    }
    const json = await readDataArtifactFromGcs(name);
    if (json === null || !json.trim()) {
      continue;
    }
    try {
      const p = JSON.parse(json) as { alerts?: unknown };
      if (!Array.isArray(p.alerts) || p.alerts.length === 0) {
        continue;
      }
    } catch {
      continue;
    }
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(localPath, json, "utf-8");
    console.log(`[gcs-sync] Hydrated ${name} from GCS`);
    count++;
  }
  return count;
}
