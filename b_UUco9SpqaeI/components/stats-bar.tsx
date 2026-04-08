"use client"

import { Bell, Sparkles, Ban, Wifi } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { DashboardUiStrings } from "@/lib/dashboard-i18n"

interface StatsBarProps {
  totalAlerts: number
  newToday: number
  duplicatesBlocked: number
  isOnline: boolean
  ui: DashboardUiStrings
}

export function StatsBar({
  totalAlerts,
  newToday,
  duplicatesBlocked,
  isOnline,
  ui,
}: StatsBarProps) {
  const stats = [
    {
      label: ui.statsTotalAlerts,
      value: totalAlerts,
      icon: Bell,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      label: ui.statsNewToday,
      value: newToday,
      icon: Sparkles,
      color: "text-amber-600",
      bgColor: "bg-amber-100",
    },
    {
      label: ui.statsDupBlocked,
      value: duplicatesBlocked,
      icon: Ban,
      color: "text-rose-600",
      bgColor: "bg-rose-100",
    },
    {
      label: ui.statsSystemStatus,
      value: isOnline ? ui.statsOnline : ui.statsOffline,
      icon: Wifi,
      color: isOnline ? "text-emerald-600" : "text-rose-600",
      bgColor: isOnline ? "bg-emerald-100" : "bg-rose-100",
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label} className="border-border/60">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div
                className={`flex items-center justify-center size-10 rounded-lg ${stat.bgColor}`}
              >
                <stat.icon className={`size-5 ${stat.color}`} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <p className="text-xl font-bold text-foreground">{stat.value}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
