/**
 * Uploads canonical JSON under DATA_DIR to GCS when SCRAPER_STORAGE=gcs.
 */
import { Storage } from "@google-cloud/storage";
import { access, writeFile } from "fs/promises";
import path from "path";

import { DATA_DIR } from "./repo-paths.js";

const DEFAULT_BUCKET = "israelscraper";

const SYNC_FILES = [
  "scan-export.json",
  "bus-alerts.json",
  "routes-database.json",
  "egged-alerts.json",
  "agencies-registry.json",
  "bus-alerts-prev.json",
] as const;

function normalizePrefix(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Object path in bucket (must match upload + download). */
export function gcsObjectPath(filename: string): string {
  const prefix = normalizePrefix(process.env.GCS_OBJECT_PREFIX?.trim() ?? "");
  return prefix ? `${prefix}/${filename}` : filename;
}

export async function uploadDataArtifactsToGcs(): Promise<string[]> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return [];
  }
  const bucketName =
    process.env.GCS_BUCKET_NAME?.trim() || DEFAULT_BUCKET;
  const projectId = process.env.GCP_PROJECT_ID?.trim();
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
    const objectName = gcsObjectPath(name);
    await bucket.upload(localPath, {
      destination: objectName,
      metadata: { contentType: "application/json" },
    });
    uploaded.push(`gs://${bucketName}/${objectName}`);
  }

  return uploaded;
}

/**
 * Upload one file from DATA_DIR (e.g. routes-database.json) — Bus Nearby incremental saves.
 */
export async function uploadDataJsonFileToGcs(filename: string): Promise<void> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return;
  }
  const bucketName =
    process.env.GCS_BUCKET_NAME?.trim() || DEFAULT_BUCKET;
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const storage = projectId
    ? new Storage({ projectId })
    : new Storage();
  const bucket = storage.bucket(bucketName);
  const localPath = path.join(DATA_DIR, filename);
  await access(localPath);
  const objectName = gcsObjectPath(filename);
  await bucket.upload(localPath, {
    destination: objectName,
    metadata: { contentType: "application/json" },
  });
}

/**
 * Before Bus Nearby run on a fresh Cloud Run instance: pull latest routes DB from GCS.
 */
export async function hydrateRoutesDatabaseFromGcsIfConfigured(): Promise<boolean> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return false;
  }
  const raw = await readDataArtifactFromGcs("routes-database.json");
  if (!raw?.trim()) {
    return false;
  }
  const fp = path.join(DATA_DIR, "routes-database.json");
  await writeFile(fp, raw, "utf-8");
  console.log(
    `[gcs-sync] hydrated routes-database.json from GCS (${raw.length} bytes)`
  );
  return true;
}

export async function readDataArtifactFromGcs(filename: string): Promise<string | null> {
  const bucketName = process.env.GCS_BUCKET_NAME || "israelscraper";
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const storage = projectId
    ? new Storage({ projectId })
    : new Storage();
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(gcsObjectPath(filename));
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return contents.toString("utf-8");
  } catch {
    return null;
  }
}
