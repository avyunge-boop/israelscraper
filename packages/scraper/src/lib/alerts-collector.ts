/**
 * Rebuilds scan-export.json + bus-alerts.json from all data/alerts-*.json (master merge).
 * With SCRAPER_STORAGE=gcs, unions GCS object names and prefers non-empty local copies, else GCS body.
 */
import { access, readFile, writeFile } from "fs/promises";
import path from "path";

import {
  listAgencyAlertFilenamesInDataDir,
  parseSourceIdFromAgencyAlertsFile,
  type AgencyAlertsFileV1,
} from "./agency-alerts-store.js";
import {
  listAgencyAlertJsonBasenamesInGcs,
  readDataArtifactFromGcs,
} from "../gcs-sync.js";
import { DATA_DIR, LEGACY_SCAN_EXPORT, SCAN_EXPORT_JSON } from "../repo-paths.js";
import type { NormalizedAlert, SourceScanResult } from "../scrapers/types.js";

interface ScanExportSourceRow {
  sourceId: string;
  displayName: string;
  success: boolean;
  scrapedAt: string;
  error: string | null;
  alerts: SourceScanResult["alerts"];
}

async function readExistingScanExportSources(): Promise<
  Map<string, ScanExportSourceRow>
> {
  const byId = new Map<string, ScanExportSourceRow>();
  const tryParse = async (file: string) => {
    try {
      const raw = JSON.parse(await readFile(file, "utf-8")) as {
        sources?: ScanExportSourceRow[];
      };
      for (const s of raw.sources ?? []) {
        byId.set(s.sourceId, s);
      }
    } catch {
      /* */
    }
  };
  await tryParse(SCAN_EXPORT_JSON);
  if (byId.size === 0) {
    await tryParse(LEGACY_SCAN_EXPORT);
  }
  return byId;
}

async function readAgencyAlertsFileBody(
  fname: string
): Promise<string | null> {
  const localPath = path.join(DATA_DIR, fname);
  if (process.env.SCRAPER_STORAGE === "gcs") {
    try {
      await access(localPath);
      const local = (await readFile(localPath, "utf-8")).trim();
      if (local) {
        const parsed = JSON.parse(local) as { alerts?: unknown };
        if (Array.isArray(parsed.alerts) && parsed.alerts.length > 0) {
          return local;
        }
      }
    } catch {
      /* missing or empty */
    }
    return readDataArtifactFromGcs(fname);
  }
  try {
    return await readFile(localPath, "utf-8");
  } catch {
    return null;
  }
}

function normalizedToMasterBusAlertRow(
  a: NormalizedAlert,
  sourceId: string
): Record<string, unknown> {
  const dispatcherHe =
    typeof a.meta?.dispatcherSummaryHe === "string"
      ? String(a.meta.dispatcherSummaryHe).trim()
      : "";
  const fullContent =
    dispatcherHe ||
    (typeof a.meta?.fullDescription === "string" &&
      String(a.meta.fullDescription).trim()) ||
    (a.content ?? "").trim() ||
    (a.title ?? "").trim() ||
    "התראה";
  const aid =
    typeof a.meta?.contentId === "string" ? String(a.meta.contentId).trim() : "";
  return {
    title: (a.title ?? "").trim() || "התראה",
    fullContent,
    effectiveStart: a.effectiveStart,
    effectiveEnd: a.effectiveEnd,
    routeUrl:
      (a.detailUrl ?? "").trim() ||
      (sourceId === "egged"
        ? "https://www.egged.co.il"
        : "https://www.busnearby.co.il"),
    agencyName: (a.operatorLabel ?? "").trim(),
    alertId: aid,
    activeNow: Boolean(a.meta?.activeNow),
    scanSourceId: sourceId,
  };
}

/**
 * Merge all alerts-*.json into scan-export (per-source rows) and bus-alerts.json (flat rows for dashboard fallback).
 */
export async function rebuildScanExportAndMasterBusAlerts(): Promise<void> {
  const byId = await readExistingScanExportSources();
  const localFiles = await listAgencyAlertFilenamesInDataDir();
  const remoteFiles =
    process.env.SCRAPER_STORAGE === "gcs"
      ? await listAgencyAlertJsonBasenamesInGcs()
      : [];
  const files = [...new Set([...localFiles, ...remoteFiles])];
  const masterRows: Record<string, unknown>[] = [];

  for (const fname of files) {
    const sid = parseSourceIdFromAgencyAlertsFile(fname);
    if (!sid) continue;
    let raw: AgencyAlertsFileV1;
    try {
      const body = await readAgencyAlertsFileBody(fname);
      if (body === null || !body.trim()) continue;
      raw = JSON.parse(body) as AgencyAlertsFileV1;
    } catch {
      continue;
    }
    const displayName = raw.displayName ?? sid;
    const scrapedAt = raw.scrapedAt ?? new Date().toISOString();
    const alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
    byId.set(sid, {
      sourceId: sid,
      displayName,
      success: true,
      scrapedAt,
      error: null,
      alerts,
    });
    for (const a of alerts) {
      masterRows.push(normalizedToMasterBusAlertRow(a, sid));
    }
  }

  const payload = {
    scrapedAt: new Date().toISOString(),
    sources: [...byId.values()],
  };
  await writeFile(SCAN_EXPORT_JSON, JSON.stringify(payload, null, 2), "utf-8");

  const masterBus = {
    schemaVersion: 2,
    format: "unified-dashboard",
    scrapedAt: payload.scrapedAt,
    alerts: masterRows,
  };
  await writeFile(
    path.join(DATA_DIR, "bus-alerts.json"),
    JSON.stringify(masterBus, null, 2),
    "utf-8"
  );

  console.log(
    `[collector] scan-export.json + bus-alerts.json ← ${files.length} agency file(s), ${masterRows.length} unified row(s)`
  );
}
