/**
 * Rebuilds scan-export.json + bus-alerts.json from all data/alerts-*.json (master merge).
 * With SCRAPER_STORAGE=gcs, unions GCS object names and prefers non-empty local copies, else GCS body.
 *
 * Safety: never replace scan-export with fewer sources than GCS baseline; never apply an agency file
 * that would wipe a previously non-empty source with an empty list (e.g. Bus Nearby mid-crash).
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

function alertCount(row: ScanExportSourceRow | undefined): number {
  if (!row?.alerts) return 0;
  return Array.isArray(row.alerts) ? row.alerts.length : 0;
}

/** Prefer the row that preserves more alert data; tie-breaker: newer scrapedAt. */
function mergeScanExportSourceRows(
  a: ScanExportSourceRow | undefined,
  b: ScanExportSourceRow | undefined
): ScanExportSourceRow | undefined {
  if (!a) return b;
  if (!b) return a;
  const ca = alertCount(a);
  const cb = alertCount(b);
  if (cb > ca) return b;
  if (ca > cb) return a;
  const ta = (a.scrapedAt ?? "").trim();
  const tb = (b.scrapedAt ?? "").trim();
  return tb > ta ? b : a;
}

async function mapFromScanExportJsonText(
  text: string | null | undefined
): Promise<Map<string, ScanExportSourceRow>> {
  const byId = new Map<string, ScanExportSourceRow>();
  if (!text?.trim()) return byId;
  try {
    const raw = JSON.parse(text) as { sources?: ScanExportSourceRow[] };
    for (const s of raw.sources ?? []) {
      if (s?.sourceId) byId.set(s.sourceId, s);
    }
  } catch {
    /* */
  }
  return byId;
}

async function readScanExportBaselineFromGcs(): Promise<
  Map<string, ScanExportSourceRow>
> {
  if (process.env.SCRAPER_STORAGE !== "gcs") {
    return new Map();
  }
  const text = await readDataArtifactFromGcs("scan-export.json");
  return mapFromScanExportJsonText(text);
}

/**
 * Baseline for merge: GCS scan-export (if gcs) ∪ local scan-export files.
 * Prevents cold disk + single empty agency file from wiping multi-agency history.
 */
async function readExistingScanExportSources(): Promise<
  Map<string, ScanExportSourceRow>
> {
  const byId = new Map<string, ScanExportSourceRow>();

  const gcsBaseline = await readScanExportBaselineFromGcs();
  for (const [k, v] of gcsBaseline) {
    byId.set(k, v);
  }

  const mergeLocalFile = async (file: string) => {
    try {
      const rawText = await readFile(file, "utf-8");
      const localMap = await mapFromScanExportJsonText(rawText);
      for (const [k, v] of localMap) {
        byId.set(k, mergeScanExportSourceRows(byId.get(k), v)!);
      }
    } catch {
      /* */
    }
  };
  await mergeLocalFile(SCAN_EXPORT_JSON);
  if (byId.size === 0) {
    await mergeLocalFile(LEGACY_SCAN_EXPORT);
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

function buildPayloadFromById(byId: Map<string, ScanExportSourceRow>): {
  sources: ScanExportSourceRow[];
  masterRows: Record<string, unknown>[];
} {
  const masterRows: Record<string, unknown>[] = [];
  for (const row of byId.values()) {
    const sid = row.sourceId;
    for (const a of row.alerts ?? []) {
      masterRows.push(normalizedToMasterBusAlertRow(a, sid));
    }
  }
  return {
    sources: [...byId.values()],
    masterRows,
  };
}

/**
 * Merge all alerts-*.json into scan-export (per-source rows) and bus-alerts.json (flat rows for dashboard fallback).
 */
export async function rebuildScanExportAndMasterBusAlerts(): Promise<void> {
  const gcsBaseline = await readScanExportBaselineFromGcs();
  const baselineSourceCount = gcsBaseline.size;
  let baselineTotalAlerts = 0;
  for (const row of gcsBaseline.values()) {
    baselineTotalAlerts += alertCount(row);
  }

  const byId = await readExistingScanExportSources();
  const localFiles = await listAgencyAlertFilenamesInDataDir();
  const remoteFiles =
    process.env.SCRAPER_STORAGE === "gcs"
      ? await listAgencyAlertJsonBasenamesInGcs()
      : [];
  const files = [...new Set([...localFiles, ...remoteFiles])];

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

    const prevRow = byId.get(sid);
    const prevN = alertCount(prevRow);
    if (alerts.length === 0 && prevN > 0) {
      console.warn(
        `[collector] refuse empty alerts-${sid} overwrite (${prevN} previous alerts kept; possible crash/partial write)`
      );
      continue;
    }

    byId.set(sid, {
      sourceId: sid,
      displayName,
      success: true,
      scrapedAt,
      error: null,
      alerts,
    });
  }

  const scrapedAt = new Date().toISOString();
  const { sources, masterRows } = buildPayloadFromById(byId);

  const newSourceCount = sources.length;
  const newTotalAlerts = masterRows.length;

  if (
    process.env.SCRAPER_STORAGE === "gcs" &&
    baselineSourceCount > 0 &&
    newSourceCount < baselineSourceCount
  ) {
    console.error(
      `[collector] ABORT write scan-export.json: new sources=${newSourceCount} < GCS baseline sources=${baselineSourceCount} (data loss guard)`
    );
    return;
  }

  if (
    process.env.SCRAPER_STORAGE === "gcs" &&
    baselineTotalAlerts > 50 &&
    newTotalAlerts < Math.floor(baselineTotalAlerts * 0.25)
  ) {
    console.error(
      `[collector] ABORT write scan-export.json: unified rows ${newTotalAlerts} << baseline ${baselineTotalAlerts} (possible corrupt merge)`
    );
    return;
  }

  const payload = {
    scrapedAt,
    sources,
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
    `[collector] scan-export.json + bus-alerts.json ← ${files.length} agency file(s), ${masterRows.length} unified row(s), ${newSourceCount} source(s)`
  );
}
