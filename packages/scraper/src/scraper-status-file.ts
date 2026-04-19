/**
 * Canonical scraper run state for GCS + dashboard (survives restarts / stale UI).
 * Force-reset: running=false, progress=0.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { uploadDataJsonFileToGcs } from "./gcs-sync.js";
import { DATA_DIR } from "./repo-paths.js";

export const SCRAPER_STATUS_FILE = "scraper-status.json";

export type ScraperStatusPayload = {
  running: boolean;
  progress: number;
  agency: string;
  startedAt: string | null;
  updatedAt: string;
};

export function defaultScraperStatus(): ScraperStatusPayload {
  const now = new Date().toISOString();
  return {
    running: false,
    progress: 0,
    agency: "",
    startedAt: null,
    updatedAt: now,
  };
}

function statusPath(): string {
  return path.join(DATA_DIR, SCRAPER_STATUS_FILE);
}

export async function readScraperStatusFromDisk(): Promise<ScraperStatusPayload | null> {
  try {
    const raw = (await readFile(statusPath(), "utf-8")).trim();
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<ScraperStatusPayload>;
    return {
      running: Boolean(j.running),
      progress:
        typeof j.progress === "number" && Number.isFinite(j.progress)
          ? Math.max(0, Math.floor(j.progress))
          : 0,
      agency: typeof j.agency === "string" ? j.agency : "",
      startedAt: typeof j.startedAt === "string" ? j.startedAt : null,
      updatedAt:
        typeof j.updatedAt === "string" ? j.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Merge into scraper-status.json under DATA_DIR; upload single object to GCS when SCRAPER_STORAGE=gcs.
 */
export async function writeScraperStatusFile(
  partial: Partial<
    Pick<ScraperStatusPayload, "running" | "progress" | "agency" | "startedAt">
  >
): Promise<ScraperStatusPayload> {
  const prev = (await readScraperStatusFromDisk()) ?? defaultScraperStatus();
  const next: ScraperStatusPayload = {
    ...prev,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    statusPath(),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  if (process.env.SCRAPER_STORAGE === "gcs") {
    await uploadDataJsonFileToGcs(SCRAPER_STATUS_FILE);
  }
  return next;
}
