import {
  alertsFromBusNearbyJson,
  alertsFromEggedJson,
  alertsFromScanExportJson,
} from "@/lib/aggregate-transport-json"
import type { TransportAlert } from "@/lib/transport-alert"
import path from "path"

import {
  expandWorkspacePaths,
  resolveCanonicalDataDir,
  resolveOrchestratorRepoRoot,
  tryReadJsonFirstExisting,
} from "@/lib/server/workspace-paths"

export const FILE_SPECS = [
  { file: "bus-alerts.json", kind: "busnearby" as const },
  { file: "egged-alerts.json", kind: "egged" as const },
]

async function resolveJsonFile(fileName: string): Promise<unknown | null> {
  const canonical = path.join(resolveCanonicalDataDir(), fileName)
  const trails: string[][] = [
    ["data", fileName],
    ["b_UUco9SpqaeI", "data", fileName],
  ]
  if (fileName === "bus-alerts.json") {
    trails.push(["bus-alerts.json"])
  }
  if (fileName === "egged-alerts.json") {
    trails.push(["scripts", "egged-alerts.json"])
    trails.push(["packages", "scraper", "egged-alerts.json"])
  }
  return tryReadJsonFirstExisting([canonical, ...expandWorkspacePaths(trails)])
}

function maxIso(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

export interface MergeTransportResult {
  alerts: TransportAlert[]
  lastUpdated: string
  /** קבצים או מקור ששימשו לבניית הרשימה */
  sourcesUsed: string[]
}

export async function mergeTransportAlertsFromDisk(): Promise<MergeTransportResult> {
  /** קנון: SCRAPER_DATA_DIR או repo/data */
  const canonicalScanExport = path.join(
    resolveCanonicalDataDir(),
    "scan-export.json"
  )
  const scanPaths = [
    canonicalScanExport,
    ...new Set(
      expandWorkspacePaths([
        ["data", "scan-export.json"],
        ["scan-export.json"],
        ["b_UUco9SpqaeI", "data", "scan-export.json"],
      ])
    ),
  ]
  for (const scanPath of scanPaths) {
    const raw = await tryReadJsonFirstExisting([scanPath])
    if (!raw) continue
    const fromScan = alertsFromScanExportJson(raw)
    if (fromScan.length > 0) {
      let lastUpdated = (raw as { scrapedAt?: string }).scrapedAt ?? ""
      for (const a of fromScan) {
        if (a.sourceScrapedAt) lastUpdated = maxIso(lastUpdated, a.sourceScrapedAt)
      }
      if (!lastUpdated) lastUpdated = new Date().toISOString()
      return {
        alerts: fromScan,
        lastUpdated,
        sourcesUsed:
          scanPath === canonicalScanExport
            ? ["data/scan-export.json (repo root)"]
            : [scanPath],
      }
    }
  }

  const merged: TransportAlert[] = []
  const sourcesUsed: string[] = []
  let lastUpdated = ""

  for (const spec of FILE_SPECS) {
    const raw = await resolveJsonFile(spec.file)
    if (!raw) continue
    sourcesUsed.push(spec.file)

    if (spec.kind === "busnearby") {
      const rows = alertsFromBusNearbyJson(raw)
      merged.push(...rows)
      const s = (raw as { scrapedAt?: string }).scrapedAt
      if (s) lastUpdated = maxIso(lastUpdated, s)
    } else {
      const rows = alertsFromEggedJson(raw)
      merged.push(...rows)
      const s = (raw as { scrapedAt?: string }).scrapedAt
      if (s) lastUpdated = maxIso(lastUpdated, s)
    }
  }

  for (const a of merged) {
    if (a.sourceScrapedAt) lastUpdated = maxIso(lastUpdated, a.sourceScrapedAt)
  }

  if (!lastUpdated) {
    lastUpdated = new Date().toISOString()
  }

  return { alerts: merged, lastUpdated, sourcesUsed }
}
