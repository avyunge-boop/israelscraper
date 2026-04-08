import { readFile } from "fs/promises"
import path from "path"

import { resolveOrchestratorRepoRoot } from "@/lib/server/workspace-paths"

const SCAN_EXPORT = () =>
  path.join(resolveOrchestratorRepoRoot(), "data", "scan-export.json")

type SourceRow = {
  sourceId: string
  displayName?: string
  success?: boolean
  scrapedAt?: string
  alerts?: unknown[]
}

function parseIso(s: string | undefined): number {
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

function startOfWeekMs(now: number): number {
  const d = new Date(now)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonthMs(now: number): number {
  const d = new Date(now)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export type DashboardStats = {
  incidentsThisWeek: number
  incidentsThisMonth: number
  incidentsPrevWeek: number
  incidentsPrevMonth: number
  weekChangePct: number | null
  monthChangePct: number | null
  agencyCounts: Record<string, number>
  topAgency: { id: string; label: string; count: number } | null
}

export async function computeDashboardStats(): Promise<DashboardStats> {
  let sources: SourceRow[] = []
  try {
    const raw = await readFile(SCAN_EXPORT(), "utf-8")
    const j = JSON.parse(raw) as { sources?: SourceRow[] }
    sources = Array.isArray(j.sources) ? j.sources : []
  } catch {
    return {
      incidentsThisWeek: 0,
      incidentsThisMonth: 0,
      incidentsPrevWeek: 0,
      incidentsPrevMonth: 0,
      weekChangePct: null,
      monthChangePct: null,
      agencyCounts: {},
      topAgency: null,
    }
  }

  const now = Date.now()
  const weekStart = startOfWeekMs(now)
  const monthStart = startOfMonthMs(now)
  const prevWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000
  const prevMonthStart = new Date(monthStart)
  prevMonthStart.setMonth(prevMonthStart.getMonth() - 1)
  const prevMonthStartMs = prevMonthStart.getTime()

  let incidentsThisWeek = 0
  let incidentsThisMonth = 0
  let incidentsPrevWeek = 0
  let incidentsPrevMonth = 0
  const agencyCounts: Record<string, number> = {}

  for (const s of sources) {
    if (!s.success) continue
    const t = parseIso(s.scrapedAt)
    const n = Array.isArray(s.alerts) ? s.alerts.length : 0
    const id = s.sourceId || "unknown"
    agencyCounts[id] = (agencyCounts[id] ?? 0) + n

    if (t >= weekStart) incidentsThisWeek += n
    else if (t >= prevWeekStart && t < weekStart) incidentsPrevWeek += n

    if (t >= monthStart) incidentsThisMonth += n
    else if (t >= prevMonthStartMs && t < monthStart) incidentsPrevMonth += n
  }

  const pct = (cur: number, prev: number): number | null => {
    if (prev === 0) return cur === 0 ? 0 : null
    return Math.round(((cur - prev) / prev) * 1000) / 10
  }

  let top: { id: string; label: string; count: number } | null = null
  for (const [id, count] of Object.entries(agencyCounts)) {
    if (!top || count > top.count) {
      const src = sources.find((x) => x.sourceId === id)
      top = { id, label: src?.displayName ?? id, count }
    }
  }

  return {
    incidentsThisWeek,
    incidentsThisMonth,
    incidentsPrevWeek,
    incidentsPrevMonth,
    weekChangePct: pct(incidentsThisWeek, incidentsPrevWeek),
    monthChangePct: pct(incidentsThisMonth, incidentsPrevMonth),
    agencyCounts,
    topAgency: top,
  }
}
