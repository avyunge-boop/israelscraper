import { createHash } from "node:crypto"

import {
  eggedAlertSummaryId,
  eggedContentIdFromLinkAndMeta,
} from "@/lib/egged-ai-summary-id"
import type {
  AlertDataSource,
  AlertProvider,
  TransportAlert,
} from "@/lib/transport-alert"

/** מזהה יציב בין סריקות — נדרש למטמון סיכומי AI בלי לשרוף מכסה */
function stableIdForScanAlert(
  sourceId: string,
  n: {
    title?: string
    content?: string
    detailUrl?: string
    meta?: Record<string, unknown>
  }
): string {
  const link = String(n.detailUrl ?? "").trim()
  const title = String(n.title ?? "").trim()
  const content = String(n.content ?? "").trim().slice(0, 240)
  const rawLines = n.meta?.lineNumbers
  const lines = Array.isArray(rawLines)
    ? rawLines.map((x) => String(x)).join(",")
    : ""
  const h = createHash("sha256")
    .update(`${sourceId}\0${link}\0${title}\0${lines}\0${content}`)
    .digest("hex")
    .slice(0, 24)
  return `scan-${sourceId}-${h}`
}

export function mapAgencyNameToProvider(agencyName: string): AlertProvider {
  const n = agencyName.trim()
  if (/אגד/i.test(n) || /egged/i.test(n)) return "אגד"
  if (/^דן$|^דן\s|דן,/i.test(n) || /^dan$/i.test(n)) return "דן"
  if (/קווים|kavim/i.test(n)) return "קווים"
  if (/מטרופולין|metropoline/i.test(n)) return "מטרופולין"
  return "אחר"
}

function formatIsoHe(iso?: string): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString("he-IL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function extractBusnearbyAgencyIds(meta: Record<string, unknown> | undefined): string[] {
  const routes = meta?.routes
  if (!Array.isArray(routes)) return []
  const ids = new Set<string>()
  for (const r of routes) {
    if (!r || typeof r !== "object") continue
    const arr = (r as { agencyFilterIds?: unknown }).agencyFilterIds
    if (!Array.isArray(arr)) continue
    for (const id of arr) {
      const s = String(id ?? "").trim()
      if (s) ids.add(s)
    }
  }
  return [...ids].sort(
    (a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b)
  )
}

/** bus-alerts.json (Bus Nearby) */
export function alertsFromBusNearbyJson(data: unknown): TransportAlert[] {
  if (!data || typeof data !== "object") return []
  const root = data as {
    scrapedAt?: string
    alerts?: Array<{
      agencyName?: string
      title?: string
      fullContent?: string
      routeUrl?: string
      apiRouteId?: string
      alertId?: string
      effectiveStart?: string
      effectiveEnd?: string
      activeNow?: boolean
      scrapedAt?: string
    }>
  }
  const list = root.alerts
  if (!Array.isArray(list)) return []
  const scraped = root.scrapedAt ?? ""
  const out: TransportAlert[] = []
  list.forEach((item, i) => {
    const title = (item.title ?? "").trim() || "התראה"
    const fullContent = (item.fullContent ?? "").trim() || title
    const link = (item.routeUrl ?? "").trim() || "https://www.busnearby.co.il"
    const api = (item.apiRouteId ?? "").trim()
    const lineNumbers = api ? [api.split(":").pop() || api] : ["—"]
    const id = `bn-${String(item.alertId ?? "").slice(0, 80) || i}-${i}`
    out.push({
      id,
      title,
      provider: mapAgencyNameToProvider(item.agencyName ?? ""),
      fullContent,
      lineNumbers,
      link,
      dateRange: {
        start: formatIsoHe(item.effectiveStart),
        end: formatIsoHe(item.effectiveEnd),
      },
      isNew: item.activeNow === true,
      sourceScrapedAt: item.scrapedAt ?? scraped,
      dataSource: "busnearby",
      discoveryDate: item.scrapedAt ?? scraped,
      alertDate: item.effectiveStart,
    })
  })
  return out
}

function parseEggedEffective(raw: string): { start: string; end: string } {
  const parts = raw.split("|").map((s) => s.trim())
  return {
    start: parts[0] || "—",
    end: parts[1] ?? parts[0] ?? "—",
  }
}

/** data/egged-alerts.json (או scripts/egged-alerts.json ישן) */
export function alertsFromEggedJson(data: unknown): TransportAlert[] {
  if (!data || typeof data !== "object") return []
  const root = data as {
    scrapedAt?: string
    alerts?: Record<
      string,
      {
        contentId?: string
        title?: string
        content?: string
        detailUrl?: string
        effectiveStart?: string
        lineNumbers?: string[]
      }
    >
  }
  const bag = root.alerts
  if (!bag || typeof bag !== "object") return []
  const scraped = root.scrapedAt ?? ""
  const out: TransportAlert[] = []
  for (const [key, item] of Object.entries(bag)) {
    const title = (item.title ?? "").trim() || "עדכון אגד"
    const content = (item.content ?? "").trim()
    const fullContent = scanExportMergedBody(content, "", title) || title
    const link = (item.detailUrl ?? "").trim() || "https://www.egged.co.il"
    const lines = Array.isArray(item.lineNumbers)
      ? item.lineNumbers.map((x) => String(x).trim()).filter(Boolean)
      : []
    const lineNumbers = lines.length > 0 ? lines : ["—"]
    const dr = parseEggedEffective((item.effectiveStart ?? "").trim())
    const cid = (item.contentId ?? "").trim() || key
    out.push({
      id: eggedAlertSummaryId((item.contentId ?? "").trim(), key),
      contentId: cid,
      title,
      provider: "אגד",
      fullContent,
      lineNumbers,
      link,
      dateRange: dr,
      isNew: false,
      sourceScrapedAt: scraped,
      dataSource: "egged",
    })
  }
  return out
}

/**
 * מאחד content + meta.fullDescription מ־scan-export (במיוחד אגד) כדי שלא יוצג רק כותרת
 * כשאחד השדות קצר והשני מכיל את גוף ההתראה המלא.
 */
function scanExportMergedBody(
  rawContent: string,
  metaFull: string,
  title: string
): string {
  const c = rawContent.trim()
  const m = metaFull.trim()
  const t = title.trim()
  if (c && m) {
    if (c === m) return c
    if (c.includes(m) || m.includes(c)) return c.length >= m.length ? c : m
    return `${c.length >= m.length ? c : m}\n\n${c.length >= m.length ? m : c}`.trim()
  }
  return c || m || t || ""
}

/** scan-export.json — פלט orchestrator אחרי סריקה */
export function alertsFromScanExportJson(data: unknown): TransportAlert[] {
  if (!data || typeof data !== "object") return []
  const root = data as {
    scrapedAt?: string
    sources?: Array<{
      sourceId: string
      displayName?: string
      success?: boolean
      scrapedAt?: string
      alerts?: Array<{
        title?: string
        content?: string
        effectiveStart?: string
        effectiveEnd?: string
        operatorLabel?: string
        detailUrl?: string
        meta?: Record<string, unknown>
      }>
    }>
  }
  if (!Array.isArray(root.sources)) return []
  const out: TransportAlert[] = []
  for (const src of root.sources) {
    if (!src.success || !Array.isArray(src.alerts)) continue
    const sourceId = src.sourceId
    const groupLabel = (src.displayName ?? sourceId).trim()
    for (const n of src.alerts) {
      const title = (n.title ?? "").trim() || "התראה"
      const dispatcherHe =
        typeof n.meta?.dispatcherSummaryHe === "string"
          ? String(n.meta.dispatcherSummaryHe).trim()
          : ""
      const summaryEn =
        typeof n.meta?.summaryEn === "string"
          ? String(n.meta.summaryEn).trim()
          : ""
      const rawContent = (n.content ?? "").trim()
      const busnearbyAgencyIds =
        sourceId === "busnearby" ? extractBusnearbyAgencyIds(n.meta) : []
      const metaFull =
        typeof n.meta?.fullDescription === "string"
          ? String(n.meta.fullDescription).trim()
          : ""
      const merged = scanExportMergedBody(rawContent, metaFull, title)
      /** תוכן מלא לכרטיס: מיזוג content+meta; אם עדיין ריק/קצר — סיכום דיספצ'ר או כותרת */
      const fullContent =
        merged ||
        dispatcherHe.trim() ||
        title
      const rawLines = n.meta?.lineNumbers
      const lines = Array.isArray(rawLines)
        ? rawLines.map((x) => String(x).trim()).filter(Boolean)
        : []
      const rawRoutes = n.meta?.routes
      const routeTokens: string[] = []
      if (Array.isArray(rawRoutes)) {
        for (const r of rawRoutes) {
          if (typeof r === "string") {
            const t = r.trim()
            if (t) routeTokens.push(t)
          } else if (r && typeof r === "object") {
            const o = r as { line?: string; pattern?: string; number?: string }
            const t = String(o.line ?? o.pattern ?? o.number ?? "").trim()
            if (t) routeTokens.push(t)
          }
        }
      }
      const mergedLines = [...lines]
      for (const t of routeTokens) {
        if (t && !mergedLines.includes(t)) mergedLines.push(t)
      }
      const lineNumbers = mergedLines.length > 0 ? mergedLines : ["—"]
      const link =
        (n.detailUrl ?? "").trim() ||
        (sourceId === "egged"
          ? "https://www.egged.co.il"
          : "https://www.busnearby.co.il")
      const start = (n.effectiveStart ?? "").trim() || "—"
      const end = (n.effectiveEnd ?? "").trim() || start
      const provider = providerFromScanSource(n, sourceId)
      const dataSource: AlertDataSource =
        sourceId === "busnearby"
          ? "busnearby"
          : sourceId === "egged"
            ? "egged"
            : "scan-export"
      const eggedCid =
        sourceId === "egged"
          ? eggedContentIdFromLinkAndMeta(link, n.meta)
          : ""
      const scanFallback = stableIdForScanAlert(sourceId, n)
      const alertId =
        sourceId === "egged"
          ? eggedAlertSummaryId(eggedCid, scanFallback)
          : scanFallback
      out.push({
        id: alertId,
        ...(sourceId === "egged" && eggedCid
          ? { contentId: eggedCid }
          : {}),
        title,
        provider,
        fullContent,
        ...(dispatcherHe ? { aiSummary: dispatcherHe } : {}),
        ...(summaryEn ? { summaryEn } : {}),
        lineNumbers,
        link,
        dateRange: { start, end },
        sourceScrapedAt: src.scrapedAt ?? root.scrapedAt,
        dataSource,
        scanSourceId: sourceId,
        agencyGroupLabel: groupLabel,
        ...(busnearbyAgencyIds.length > 0
          ? { busnearbyAgencyIds }
          : {}),
        discoveryDate: src.scrapedAt ?? root.scrapedAt,
        alertDate: n.effectiveStart,
      })
    }
  }
  return out
}

function providerFromScanSource(
  n: { operatorLabel?: string },
  sourceId: string
): AlertProvider {
  if (sourceId === "busnearby") {
    return mapAgencyNameToProvider(String(n.operatorLabel ?? ""))
  }
  switch (sourceId) {
    case "egged":
      return "אגד"
    case "dan":
      return "דן"
    case "kavim":
      return "קווים"
    case "metropoline":
      return "מטרופולין"
    default:
      return mapAgencyNameToProvider(String(n.operatorLabel ?? ""))
  }
}
