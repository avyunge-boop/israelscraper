"use client"

import { useEffect, useState } from "react"
import { TrendingDown, TrendingUp, BarChart3 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { DashboardUiStrings } from "@/lib/dashboard-i18n"

interface DashboardStats {
  incidentsThisWeek: number
  incidentsThisMonth: number
  incidentsPrevWeek: number
  incidentsPrevMonth: number
  weekChangePct: number | null
  monthChangePct: number | null
  agencyCounts: Record<string, number>
  topAgency: { id: string; label: string; count: number } | null
}

interface StatsViewProps {
  ui: DashboardUiStrings
}

export function StatsView({ ui }: StatsViewProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<DashboardStats>
      })
      .then(setStats)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Error")
      )
  }, [])

  if (err) {
    return (
      <p className="text-sm text-destructive">{ui.statsLoadError}: {err}</p>
    )
  }
  if (!stats) {
    return <p className="text-sm text-muted-foreground">{ui.statsLoading}</p>
  }

  const pct = (v: number | null) =>
    v === null ? "—" : `${v > 0 ? "+" : ""}${v}%`

  return (
    <div className="space-y-6">
      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Card className="min-h-[200px] w-full min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {ui.statsThisWeek}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{stats.incidentsThisWeek}</p>
            <p className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-1 break-words">
              {stats.weekChangePct != null && stats.weekChangePct >= 0 ? (
                <TrendingUp className="size-3 shrink-0 text-emerald-600" />
              ) : (
                <TrendingDown className="size-3 shrink-0 text-rose-600" />
              )}
              {ui.statsVsPrevWeek} {pct(stats.weekChangePct)}
            </p>
          </CardContent>
        </Card>
        <Card className="min-h-[200px] w-full min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {ui.statsThisMonth}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{stats.incidentsThisMonth}</p>
            <p className="text-xs text-muted-foreground mt-1 break-words">
              {ui.statsVsPrevMonth} {pct(stats.monthChangePct)}
            </p>
          </CardContent>
        </Card>
        <Card className="min-h-[200px] w-full min-w-0 md:col-span-2 xl:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex flex-wrap items-center gap-2">
              <BarChart3 className="size-4 shrink-0" />
              {ui.statsTopAgency}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats.topAgency ? (
              <p className="text-lg font-semibold break-words">
                {stats.topAgency.label}{" "}
                <span className="text-muted-foreground font-normal">
                  ({stats.topAgency.count} {ui.statsAlerts})
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">—</p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="w-full min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{ui.statsByAgency}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm space-y-1">
            {Object.entries(stats.agencyCounts).map(([id, n]) => (
              <li key={id} className="flex justify-between gap-4">
                <span className="font-mono">{id}</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
