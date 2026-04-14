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
  tryReadJsonFirstExisting,
} from "@/lib/server/workspace-paths"
import {
  fetchScraperDataJson,
  getScraperApiBaseUrl,
} from "@/lib/server/scraper-api"

export const FILE_SPECS = [
  { file: "bus-alerts.json", kind: "busnearby" as const },
  { file: "egged-alerts.json", kind: "egged" as const },
]

async function resolveJsonFile(fileName: string): Promise<unknown | null> {
  if (getScraperApiBaseUrl()) {
    const remote = await fetchScraperDataJson(fileName)
    if (remote !== null) return remote
  }
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

/** זמני סריקה אחרונים לפי מקור — מ־scan-export.json */
export type ScanSourceTimestamp = {
  sourceId: string
  displayName?: string
  scrapedAt?: string
  success?: boolean
}

export function scanSourceTimestampsFromScanExport(
  raw: unknown
): ScanSourceTimestamp[] {
  if (!raw || typeof raw !== "object") return []
  const root = raw as { sources?: unknown[] }
  if (!Array.isArray(root.sources)) return []
  return root.sources
    .map((s) => {
      const o = s as {
        sourceId?: string
        displayName?: string
        scrapedAt?: string
        success?: boolean
      }
      return {
        sourceId: String(o.sourceId ?? "").trim(),
        displayName:
          typeof o.displayName === "string" ? o.displayName.trim() : undefined,
        scrapedAt:
          typeof o.scrapedAt === "string" ? o.scrapedAt.trim() : undefined,
        success: o.success,
      }
    })
    .filter((x) => x.sourceId.length > 0)
}

export interface MergeTransportResult {
  alerts: TransportAlert[]
  lastUpdated: string
  /** קבצים או מקור ששימשו לבניית הרשימה */
  sourcesUsed: string[]
  /** מופיע כשהמקור הוא scan-export (לדשבורד) */
  scanSourceTimestamps?: ScanSourceTimestamp[]
}

export async function mergeTransportAlertsFromDisk(): Promise<MergeTransportResult> {
  const agencyRegistryRaw = await resolveJsonFile("agencies-registry.json")
  const agencyLabelById = new Map<string, string>()
  if (agencyRegistryRaw && typeof agencyRegistryRaw === "object") {
    const agencies = (agencyRegistryRaw as { agencies?: unknown }).agencies
    if (Array.isArray(agencies)) {
      for (const row of agencies) {
        if (!row || typeof row !== "object") continue
        const id = String((row as { id?: unknown }).id ?? "").trim()
        const label = String((row as { label?: unknown }).label ?? "").trim()
        if (id && label) agencyLabelById.set(id, label)
      }
    }
  }

  const enrichBusnearbyAgencyLabels = (rows: TransportAlert[]) => {
    for (const a of rows) {
      if (a.dataSource !== "busnearby") continue
      const ids = Array.isArray(a.busnearbyAgencyIds) ? a.busnearbyAgencyIds : []
      if (ids.length === 0) continue
      const labels = ids.map((id) => agencyLabelById.get(id) ?? `agencyFilter=${id}`)
      a.busnearbyAgencyLabels = labels
      a.agencyGroupLabel = labels.join(" / ")
    }
  }

  /** קנון: SCRAPER_DATA_DIR או repo/data */
  const canonicalScanExport = path.join(
    resolveCanonicalDataDir(),
    "scan-export.json"
  )
  if (getScraperApiBaseUrl()) {
    const rawRemote = await fetchScraperDataJson("scan-export.json")
    if (rawRemote) {
      const fromScan = alertsFromScanExportJson(rawRemote)
      if (fromScan.length > 0) {
        enrichBusnearbyAgencyLabels(fromScan)
        let lastUpdated = (rawRemote as { scrapedAt?: string }).scrapedAt ?? ""
        for (const a of fromScan) {
          if (a.sourceScrapedAt) lastUpdated = maxIso(lastUpdated, a.sourceScrapedAt)
        }
        if (!lastUpdated) lastUpdated = new Date().toISOString()
        return {
          alerts: fromScan,
          lastUpdated,
          sourcesUsed: ["scan-export.json (SCRAPER_API_URL)"],
          scanSourceTimestamps: scanSourceTimestampsFromScanExport(rawRemote),
        }
      }
    }
  }
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
      enrichBusnearbyAgencyLabels(fromScan)
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
        scanSourceTimestamps: scanSourceTimestampsFromScanExport(raw),
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
    if (a.dataSource === "busnearby") {
      const ids = Array.isArray(a.busnearbyAgencyIds) ? a.busnearbyAgencyIds : []
      if (ids.length > 0) {
        const labels = ids.map((id) => agencyLabelById.get(id) ?? `agencyFilter=${id}`)
        a.busnearbyAgencyLabels = labels
        a.agencyGroupLabel = labels.join(" / ")
      }
    }
    if (a.sourceScrapedAt) lastUpdated = maxIso(lastUpdated, a.sourceScrapedAt)
  }

  if (!lastUpdated) {
    lastUpdated = new Date().toISOString()
  }

  return { alerts: merged, lastUpdated, sourcesUsed }
}
