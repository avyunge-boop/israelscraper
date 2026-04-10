/**
 * Uploads canonical JSON under DATA_DIR to GCS when SCRAPER_STORAGE=gcs.
 */
import { Storage } from "@google-cloud/storage";
import { access } from "fs/promises";
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

export async function readDataArtifactFromGcs(filename: string): Promise<string | null> {
  const bucketName = process.env.GCS_BUCKET_NAME || "israelscraper";
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(filename);
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return contents.toString("utf-8");
  } catch {
    return null;
  }
}
