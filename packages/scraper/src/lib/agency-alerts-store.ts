/**
 * Per-agency isolated alert files: data/alerts-<sourceId>.json (local + GCS).
 */
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "fs/promises";
import path from "path";

import { DATA_DIR } from "../repo-paths.js";
import type { NormalizedAlert, SourceScanResult } from "../scrapers/types.js";

export const AGENCY_ALERTS_PREFIX = "alerts-";
export const AGENCY_ALERTS_SUFFIX = ".json";

export function agencyAlertsFileName(sourceId: string): string {
  const id = sourceId.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  return `${AGENCY_ALERTS_PREFIX}${id}${AGENCY_ALERTS_SUFFIX}`;
}

export function agencyAlertsPath(sourceId: string): string {
  return path.join(DATA_DIR, agencyAlertsFileName(sourceId));
}

export function parseSourceIdFromAgencyAlertsFile(filename: string): string | null {
  const m = filename.match(/^alerts-([a-z0-9-]+)\.json$/i);
  return m?.[1] ?? null;
}

export interface AgencyAlertsFileV1 {
  schemaVersion: 1;
  sourceId: string;
  displayName: string;
  scrapedAt: string;
  alerts: NormalizedAlert[];
  /** For Bus Nearby email diff (contentId list from last successful dedupe). */
  lastContentIds?: string[];
}

export function stableNormalizedAlertKey(
  sourceId: string,
  a: NormalizedAlert
): string {
  const cid =
    typeof a.meta?.contentId === "string" ? String(a.meta.contentId).trim() : "";
  if (cid) return `${sourceId}:${cid}`;
  const h = createHash("sha256")
    .update(
      `${sourceId}\0${a.title}\0${a.content}\0${String(a.detailUrl ?? "")}`
    )
    .digest("hex")
    .slice(0, 32);
  return `${sourceId}:h:${h}`;
}

/**
 * Latest website scan is the source of truth: only alerts returned in `incoming`
 * are kept. Cached alerts whose keys are absent from the new scan are dropped
 * (they are no longer published on the site).
 */
export function mergeNormalizedAlertsByKey(
  _existing: NormalizedAlert[],
  incoming: NormalizedAlert[],
  sourceId: string
): NormalizedAlert[] {
  const map = new Map<string, NormalizedAlert>();
  for (const a of incoming) {
    map.set(stableNormalizedAlertKey(sourceId, a), a);
  }
  return [...map.values()];
}

export async function mergeAndSaveAgencyAlertsFile(
  r: SourceScanResult,
  opts?: { lastContentIds?: string[] }
): Promise<void> {
  if (!r.success && r.alerts.length === 0) return;

  const sourceId = r.sourceId;
  const fp = agencyAlertsPath(sourceId);
  const fileName = agencyAlertsFileName(sourceId);
  let existing: NormalizedAlert[] = [];
  let priorLastIds: string[] | undefined;
  let loadedExisting = false;

  /** Cloud Run: GCS is source of truth; disk is ephemeral. */
  if (process.env.SCRAPER_STORAGE === "gcs") {
    const { readDataArtifactFromGcs } = await import("../gcs-sync.js");
    const gcsJson = await readDataArtifactFromGcs(fileName);
    if (gcsJson?.trim()) {
      try {
        const raw = JSON.parse(gcsJson) as AgencyAlertsFileV1;
        if (Array.isArray(raw.alerts)) existing = raw.alerts;
        if (Array.isArray(raw.lastContentIds)) priorLastIds = raw.lastContentIds;
        loadedExisting = true;
      } catch {
        /* invalid JSON in GCS */
      }
    }
  }

  if (!loadedExisting) {
    try {
      await access(fp);
      const raw = JSON.parse(await readFile(fp, "utf-8")) as AgencyAlertsFileV1;
      if (Array.isArray(raw.alerts)) existing = raw.alerts;
      if (Array.isArray(raw.lastContentIds)) priorLastIds = raw.lastContentIds;
    } catch {
      /* no local file */
    }
  }

  const merged = mergeNormalizedAlertsByKey(existing, r.alerts, sourceId);
  const blob: AgencyAlertsFileV1 = {
    schemaVersion: 1,
    sourceId,
    displayName: r.displayName,
    scrapedAt: r.scrapedAt,
    alerts: merged,
    ...(opts?.lastContentIds !== undefined
      ? { lastContentIds: opts.lastContentIds }
      : priorLastIds !== undefined
        ? { lastContentIds: priorLastIds }
        : {}),
  };
  await writeFile(fp, JSON.stringify(blob, null, 2), "utf-8");
  console.log(
    `[agency-alerts] ${fileName} → ${merged.length} alert(s) (latest scan only; stale removed)`
  );
}

export async function listAgencyAlertFilenamesInDataDir(): Promise<string[]> {
  try {
    const names = await readdir(DATA_DIR);
    return names.filter((n) => /^alerts-[a-z0-9-]+\.json$/i.test(n));
  } catch {
    return [];
  }
}
